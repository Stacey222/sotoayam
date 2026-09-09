begin;

create table public.admin_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references public.users (id),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  csrf_token_hash text not null check (csrf_token_hash ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_reason text check (revoked_reason is null or revoked_reason in
    ('LOGOUT', 'PASSWORD_CHANGED', 'REVOKED_BY_ADMIN', 'SUPERSEDED', 'EXPIRED_PRUNE')),
  client_ip inet,
  user_agent_digest text check (user_agent_digest is null or length(user_agent_digest) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expires_at > issued_at),
  check (revoked_at is null or revoked_at >= issued_at),
  check (revoked_at is null or revoked_reason is not null)
);

create index admin_sessions_user_live_idx
  on public.admin_sessions (user_id, expires_at desc) where revoked_at is null;
create index admin_sessions_expiry_idx on public.admin_sessions (expires_at);

create trigger set_admin_sessions_updated_at
before update on public.admin_sessions
for each row execute function public.set_governance_updated_at();

create table public.admin_login_attempts (
  id bigint generated always as identity primary key,
  user_id bigint references public.users (id),
  client_ip inet,
  succeeded boolean not null,
  failure_reason text check (failure_reason is null or failure_reason in
    ('UNKNOWN_EMAIL', 'BAD_PASSWORD', 'INACTIVE_USER', 'LOCKED_OUT')),
  attempted_at timestamptz not null default now(),
  check (succeeded or failure_reason is not null),
  check (not succeeded or user_id is not null)
);

create index admin_login_attempts_user_idx
  on public.admin_login_attempts (user_id, attempted_at desc) where user_id is not null;
create index admin_login_attempts_ip_idx
  on public.admin_login_attempts (client_ip, attempted_at desc) where client_ip is not null;

alter table public.admin_sessions enable row level security;
alter table public.admin_login_attempts enable row level security;

revoke all on table public.admin_sessions, public.admin_login_attempts from public, anon, authenticated, service_role;
revoke all on sequence public.admin_login_attempts_id_seq from public, anon, authenticated, service_role;

create function public.evaluate_admin_login_gate(p_user_id bigint, p_client_ip inet)
returns table (locked boolean, retry_after_seconds integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  lock_until timestamptz;
begin
  if p_user_id is not null then
    select max(attempted_at) + interval '15 minutes' into lock_until
    from (
      select attempted_at from public.admin_login_attempts
      where user_id = p_user_id and not succeeded
        and failure_reason in ('BAD_PASSWORD', 'INACTIVE_USER')
        and attempted_at > now() - interval '15 minutes'
        and attempted_at > coalesce((select max(success.attempted_at)
          from public.admin_login_attempts success
          where success.user_id = p_user_id and success.succeeded), '-infinity'::timestamptz)
      order by attempted_at desc limit 5
    ) recent
    having count(*) >= 5;
  elsif p_client_ip is not null then
    select max(attempted_at) + interval '15 minutes' into lock_until
    from (
      select attempted_at from public.admin_login_attempts
      where client_ip = p_client_ip and not succeeded
        and failure_reason = 'UNKNOWN_EMAIL'
        and attempted_at > now() - interval '15 minutes'
      order by attempted_at desc limit 50
    ) recent
    having count(*) >= 50;
  end if;

  locked := lock_until is not null and lock_until > now();
  retry_after_seconds := case when locked then greatest(1, ceil(extract(epoch from lock_until - now()))::integer) else 0 end;
  return next;
end;
$$;

create function public.record_admin_login_failure(
  p_user_id bigint, p_client_ip inet, p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_reason not in ('UNKNOWN_EMAIL', 'BAD_PASSWORD', 'INACTIVE_USER', 'LOCKED_OUT') then
    raise exception using errcode = '22023', message = 'INVALID_LOGIN_FAILURE_REASON';
  end if;
  insert into public.admin_login_attempts (user_id, client_ip, succeeded, failure_reason)
  values (p_user_id, p_client_ip, false, p_reason);
  insert into public.audit_logs
    (actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source)
  values ('SYSTEM', null,
    case when p_reason = 'LOCKED_OUT' then 'ADMIN_LOGIN_BLOCKED' else 'ADMIN_LOGIN_FAILED' end,
    'ADMIN_SESSION', coalesce(p_user_id::text, 'UNKNOWN'), null,
    jsonb_build_object('reason', p_reason, 'known_user', p_user_id is not null), 'admin_session_api');
  delete from public.admin_login_attempts where attempted_at < now() - interval '30 days';
end;
$$;

create function public.create_admin_session(
  p_user_id bigint, p_token_hash text, p_csrf_token_hash text,
  p_absolute_ttl_seconds integer, p_client_ip inet, p_user_agent_digest text
)
returns table (session_id uuid, issued_at timestamptz, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  created public.admin_sessions;
  superseded_count integer;
begin
  if p_token_hash !~ '^[0-9a-f]{64}$' or p_csrf_token_hash !~ '^[0-9a-f]{64}$'
     or p_absolute_ttl_seconds < 900 or p_absolute_ttl_seconds > 604800
     or p_user_agent_digest is not null and length(p_user_agent_digest) > 120 then
    raise exception using errcode = '22023', message = 'INVALID_SESSION_MATERIAL';
  end if;
  if not exists (
    select 1 from public.users u join public.admin_credentials c on c.user_id = u.id
    where u.id = p_user_id and u.active
  ) then
    raise exception using errcode = '42501', message = 'ADMIN_LOGIN_NOT_ALLOWED';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('admin_session_cap:' || p_user_id::text, 0));

  insert into public.admin_sessions
    (user_id, token_hash, csrf_token_hash, expires_at, client_ip, user_agent_digest)
  values (p_user_id, p_token_hash, p_csrf_token_hash,
    now() + make_interval(secs => p_absolute_ttl_seconds), p_client_ip, p_user_agent_digest)
  returning * into created;

  insert into public.admin_login_attempts (user_id, client_ip, succeeded)
  values (p_user_id, p_client_ip, true);

  with excess as (
    select candidate.id from public.admin_sessions candidate
    where candidate.user_id = p_user_id and candidate.revoked_at is null
    order by candidate.issued_at desc, candidate.id desc offset 10
  )
  update public.admin_sessions s set revoked_at = now(), revoked_reason = 'SUPERSEDED'
  from excess where s.id = excess.id;
  get diagnostics superseded_count = row_count;

  insert into public.audit_logs
    (actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source)
  values ('USER', p_user_id, 'ADMIN_LOGIN_SUCCEEDED', 'ADMIN_SESSION', created.id::text, null,
    jsonb_build_object('expires_at', created.expires_at), 'admin_session_api');
  if superseded_count > 0 then
    insert into public.audit_logs
      (actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source)
    values ('USER', p_user_id, 'ADMIN_SESSION_REVOKED', 'ADMIN_SESSION', created.id::text, null,
      jsonb_build_object('reason', 'SUPERSEDED', 'count', superseded_count), 'admin_session_api');
  end if;

  delete from public.admin_sessions stale where stale.expires_at < now() - interval '30 days';
  delete from public.admin_login_attempts where attempted_at < now() - interval '30 days';

  return query select created.id, created.issued_at, created.expires_at;
end;
$$;

create function public.validate_admin_session(
  p_token_hash text, p_idle_timeout_seconds integer, p_touch_after_seconds integer
)
returns table (
  session_id uuid, user_id bigint, email text, display_name text,
  expires_at timestamptz, csrf_token_hash text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  matched public.admin_sessions;
begin
  if p_token_hash !~ '^[0-9a-f]{64}$' or p_idle_timeout_seconds < 300
     or p_touch_after_seconds <> 60 then
    return;
  end if;
  select s.* into matched from public.admin_sessions s
  join public.users u on u.id = s.user_id
  where s.token_hash = p_token_hash and s.revoked_at is null and u.active
    and s.expires_at > now()
    and s.last_seen_at > now() - make_interval(secs => p_idle_timeout_seconds);
  if not found then return; end if;

  if matched.last_seen_at <= now() - make_interval(secs => p_touch_after_seconds) then
    update public.admin_sessions set last_seen_at = now() where id = matched.id;
  end if;

  return query
  select matched.id, u.id, c.email, u.display_name, matched.expires_at, matched.csrf_token_hash
  from public.users u join public.admin_credentials c on c.user_id = u.id
  where u.id = matched.user_id;
end;
$$;

create function public.revoke_admin_session(
  p_session_id uuid, p_reason text, p_actor_user_id bigint
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed boolean;
begin
  if p_reason not in ('LOGOUT', 'REVOKED_BY_ADMIN') then
    raise exception using errcode = '22023', message = 'INVALID_SESSION_REVOCATION_REASON';
  end if;
  update public.admin_sessions set revoked_at = now(), revoked_reason = p_reason
  where id = p_session_id and revoked_at is null
    and user_id = p_actor_user_id;
  changed := found;
  if changed then
    insert into public.audit_logs
      (actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source)
    values ('USER', p_actor_user_id,
      case when p_reason = 'LOGOUT' then 'ADMIN_LOGOUT' else 'ADMIN_SESSION_REVOKED' end,
      'ADMIN_SESSION', p_session_id::text, null,
      jsonb_build_object('reason', p_reason), 'admin_session_api');
  end if;
  return changed;
end;
$$;

create function public.revoke_admin_sessions_for_user(
  p_user_id bigint, p_reason text, p_actor_user_id bigint, p_except_session_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed_count integer;
begin
  if p_reason not in ('PASSWORD_CHANGED', 'REVOKED_BY_ADMIN') then
    raise exception using errcode = '22023', message = 'INVALID_SESSION_REVOCATION_REASON';
  end if;
  update public.admin_sessions set revoked_at = now(), revoked_reason = p_reason
  where user_id = p_user_id and revoked_at is null
    and (p_except_session_id is null or id <> p_except_session_id);
  get diagnostics changed_count = row_count;
  if changed_count > 0 then
    insert into public.audit_logs
      (actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source)
    values ('USER', p_actor_user_id, 'ADMIN_SESSION_REVOKED', 'ADMIN_SESSION', p_user_id::text, null,
      jsonb_build_object('reason', p_reason, 'count', changed_count), 'admin_session_api');
  end if;
  return changed_count;
end;
$$;

create function public.change_admin_password(
  p_user_id bigint, p_algorithm text, p_hash text, p_actor_user_id bigint, p_keep_session_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed_count integer;
begin
  if p_algorithm <> 'scrypt' or coalesce(length(p_hash), 0) < 40 or length(p_hash) > 512 then
    raise exception using errcode = '22023', message = 'INVALID_CREDENTIAL_MATERIAL';
  end if;
  update public.admin_credentials set password_algorithm = p_algorithm,
    password_hash = p_hash, password_updated_at = now()
  where user_id = p_user_id;
  if not found then raise exception using errcode = 'P0002', message = 'ADMIN_CREDENTIAL_NOT_FOUND'; end if;

  update public.admin_sessions set revoked_at = now(), revoked_reason = 'PASSWORD_CHANGED'
  where user_id = p_user_id and revoked_at is null
    and (p_keep_session_id is null or id <> p_keep_session_id);
  get diagnostics changed_count = row_count;

  insert into public.audit_logs
    (actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source)
  values ('USER', p_actor_user_id, 'ADMIN_PASSWORD_CHANGED', 'ADMIN_CREDENTIAL', p_user_id::text, null,
    jsonb_build_object('sessions_revoked', changed_count, 'algorithm', p_algorithm), 'admin_session_api');
end;
$$;

create function public.list_admin_sessions(p_user_id bigint)
returns table (
  session_id uuid, issued_at timestamptz, expires_at timestamptz,
  last_seen_at timestamptz, revoked_at timestamptz, revoked_reason text,
  client_ip inet, user_agent_digest text
)
language sql
security definer
set search_path = ''
as $$
  select id, issued_at, expires_at, last_seen_at, revoked_at, revoked_reason, client_ip, user_agent_digest
  from public.admin_sessions where user_id = p_user_id order by issued_at desc, id desc;
$$;

revoke all on function public.evaluate_admin_login_gate(bigint, inet) from public, anon, authenticated;
revoke all on function public.record_admin_login_failure(bigint, inet, text) from public, anon, authenticated;
revoke all on function public.create_admin_session(bigint, text, text, integer, inet, text) from public, anon, authenticated;
revoke all on function public.validate_admin_session(text, integer, integer) from public, anon, authenticated;
revoke all on function public.revoke_admin_session(uuid, text, bigint) from public, anon, authenticated;
revoke all on function public.revoke_admin_sessions_for_user(bigint, text, bigint, uuid) from public, anon, authenticated;
revoke all on function public.change_admin_password(bigint, text, text, bigint, uuid) from public, anon, authenticated;
revoke all on function public.list_admin_sessions(bigint) from public, anon, authenticated;

grant execute on function public.evaluate_admin_login_gate(bigint, inet) to service_role;
grant execute on function public.record_admin_login_failure(bigint, inet, text) to service_role;
grant execute on function public.create_admin_session(bigint, text, text, integer, inet, text) to service_role;
grant execute on function public.validate_admin_session(text, integer, integer) to service_role;
grant execute on function public.revoke_admin_session(uuid, text, bigint) to service_role;
grant execute on function public.revoke_admin_sessions_for_user(bigint, text, bigint, uuid) to service_role;
grant execute on function public.change_admin_password(bigint, text, text, bigint, uuid) to service_role;
grant execute on function public.list_admin_sessions(bigint) to service_role;

comment on table public.admin_sessions is 'Opaque administrator sessions; only token and CSRF hashes are stored.';
comment on table public.admin_login_attempts is 'Bounded administrator login failure history without attempted email storage.';

commit;
