begin;

alter table public.admin_credentials
  add column password_change_required boolean not null default false;

drop function public.validate_admin_session(text, integer, integer);
create function public.validate_admin_session(
  p_token_hash text, p_idle_timeout_seconds integer, p_touch_after_seconds integer
)
returns table (
  session_id uuid, user_id bigint, email text, display_name text,
  expires_at timestamptz, csrf_token_hash text, password_change_required boolean
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
  select matched.id, u.id, c.email, u.display_name, matched.expires_at,
    matched.csrf_token_hash, c.password_change_required
  from public.users u join public.admin_credentials c on c.user_id = u.id
  where u.id = matched.user_id;
end;
$$;

create or replace function public.change_admin_password(
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
    password_hash = p_hash, password_updated_at = now(), password_change_required = false
  where user_id = p_user_id;
  if not found then raise exception using errcode = 'P0002', message = 'ADMIN_CREDENTIAL_NOT_FOUND'; end if;

  update public.admin_sessions set revoked_at = now(), revoked_reason = 'PASSWORD_CHANGED'
  where user_id = p_user_id and revoked_at is null
    and (p_keep_session_id is null or id <> p_keep_session_id);
  get diagnostics changed_count = row_count;

  insert into public.audit_logs
    (actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source)
  values ('USER', p_actor_user_id, 'ADMIN_PASSWORD_CHANGED', 'ADMIN_CREDENTIAL', p_user_id::text, null,
    jsonb_build_object('sessions_revoked', changed_count, 'algorithm', p_algorithm,
      'password_change_required', false), 'admin_session_api');
end;
$$;

create function public.list_managed_admin_users(
  p_actor_user_id bigint,
  p_q text default null,
  p_status text default null,
  p_division_id bigint default null,
  p_system_admin boolean default null,
  p_has_login boolean default null,
  p_limit integer default 26,
  p_cursor_created_at timestamptz default null,
  p_cursor_id bigint default null
)
returns table (
  user_id bigint, display_name text, email text, business_user_code text,
  division_id bigint, division_code text, division_name text, division_active boolean,
  division_grants_system_authority boolean,
  role_id bigint, role_code text, role_name text, role_active boolean,
  user_active boolean, telegram_connected boolean, has_login boolean,
  password_change_required boolean, system_admin boolean, effective_system_admin boolean,
  created_at timestamptz, updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  search_pattern text;
begin
  perform public.assert_it_system_admin(p_actor_user_id);
  if p_status is not null and p_status not in ('pending', 'active', 'inactive') then
    raise exception using errcode = '22023', message = 'INVALID_STATUS';
  end if;
  if p_limit < 1 or p_limit > 101 then
    raise exception using errcode = '22023', message = 'INVALID_LIMIT';
  end if;
  if (p_cursor_created_at is null) <> (p_cursor_id is null) then
    raise exception using errcode = '22023', message = 'INVALID_CURSOR';
  end if;
  if p_q is not null then
    if length(trim(p_q)) < 1 or length(trim(p_q)) > 120 then
      raise exception using errcode = '22023', message = 'INVALID_QUERY';
    end if;
    search_pattern := '%' || replace(replace(replace(trim(p_q), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  return query
  select u.id, u.display_name, credentials.email, u.business_user_code,
    divisions.id, divisions.code, divisions.name, divisions.active, divisions.grants_system_authority,
    roles.id, roles.code, roles.name, roles.active,
    u.active,
    exists (select 1 from public.user_channels channels
      where channels.user_id = u.id and channels.channel_type = 'TELEGRAM' and channels.active),
    credentials.user_id is not null,
    coalesce(credentials.password_change_required, false),
    exists (select 1 from public.system_authority_assignments assignments
      where assignments.user_id = u.id and assignments.authority_code = 'SYSTEM_ADMIN' and assignments.revoked_at is null),
    public.is_effective_system_admin(u.id),
    u.created_at, u.updated_at
  from public.users u
  left join public.divisions divisions on divisions.id = u.division_id
  left join public.roles roles on roles.id = u.role_id
  left join public.admin_credentials credentials on credentials.user_id = u.id
  where (p_q is null or u.display_name ilike search_pattern escape '\'
      or credentials.email ilike search_pattern escape '\'
      or u.business_user_code ilike search_pattern escape '\')
    and (p_status is null
      or p_status = 'active' and u.active
      or p_status = 'pending' and not u.active and (u.division_id is null or u.role_id is null)
      or p_status = 'inactive' and not u.active and u.division_id is not null and u.role_id is not null)
    and (p_division_id is null or u.division_id = p_division_id)
    and (p_system_admin is null or p_system_admin = exists (
      select 1 from public.system_authority_assignments assignments
      where assignments.user_id = u.id and assignments.authority_code = 'SYSTEM_ADMIN' and assignments.revoked_at is null))
    and (p_has_login is null or p_has_login = (credentials.user_id is not null))
    and (p_cursor_created_at is null or (u.created_at, u.id) < (p_cursor_created_at, p_cursor_id))
  order by u.created_at desc, u.id desc
  limit p_limit;
end;
$$;

create function public.create_administrator_account(
  p_display_name text, p_email text, p_division_id bigint, p_role_id bigint,
  p_grant_system_admin boolean, p_reason text, p_password_algorithm text,
  p_password_hash text, p_actor_user_id bigint
)
returns table (user_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  created public.users;
  division_row public.divisions;
  role_row public.roles;
begin
  perform pg_advisory_xact_lock(hashtextextended('gwens_system_admin_invariant', 0));
  perform public.assert_it_system_admin(p_actor_user_id);
  if p_display_name is null or length(trim(p_display_name)) < 1 or length(trim(p_display_name)) > 120
     or p_display_name ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023', message = 'INVALID_DISPLAY_NAME';
  end if;
  if p_email is null or p_email <> lower(trim(p_email)) or length(p_email) > 254 then
    raise exception using errcode = '22023', message = 'INVALID_EMAIL';
  end if;
  if p_reason is null or length(trim(p_reason)) < 1 or length(p_reason) > 500 then
    raise exception using errcode = '22023', message = 'INVALID_REASON';
  end if;
  if p_password_algorithm <> 'scrypt' or coalesce(length(p_password_hash), 0) < 40 or length(p_password_hash) > 512 then
    raise exception using errcode = '22023', message = 'INVALID_CREDENTIAL_MATERIAL';
  end if;
  select * into division_row from public.divisions where id = p_division_id for share;
  if not found or not division_row.active then raise exception using errcode = '23503', message = 'ACTIVE_DIVISION_REQUIRED'; end if;
  select * into role_row from public.roles where id = p_role_id for share;
  if not found or not role_row.active then raise exception using errcode = '23503', message = 'ACTIVE_ROLE_REQUIRED'; end if;
  if p_grant_system_admin and not division_row.grants_system_authority then
    raise exception using errcode = 'P0001', message = 'SYSTEM_ADMIN candidate must be active in an authority-capable division';
  end if;

  insert into public.users (display_name, division_id, role_id, active)
  values (trim(p_display_name), p_division_id, p_role_id, true) returning * into created;
  insert into public.admin_credentials
    (user_id, email, password_algorithm, password_hash, password_change_required)
  values (created.id, p_email, p_password_algorithm, p_password_hash, true);
  insert into public.audit_logs
    (actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source)
  values ('USER', p_actor_user_id, 'ADMIN_USER_CREATED', 'USER', created.id::text, null,
     jsonb_build_object('division_id', p_division_id, 'role_id', p_role_id, 'active', true,
       'has_login', true, 'password_change_required', true, 'reason', trim(p_reason)), 'admin_user_management_api');
  if p_grant_system_admin then
    perform public.assign_system_admin(created.id, trim(p_reason), p_actor_user_id);
  end if;
  return query select created.id;
end;
$$;

create function public.grant_admin_login(
  p_user_id bigint, p_email text, p_reason text, p_password_algorithm text,
  p_password_hash text, p_actor_user_id bigint
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.users;
begin
  perform pg_advisory_xact_lock(hashtextextended('gwens_system_admin_invariant', 0));
  perform public.assert_it_system_admin(p_actor_user_id);
  if p_email is null or p_email <> lower(trim(p_email)) or length(p_email) > 254 then
    raise exception using errcode = '22023', message = 'INVALID_EMAIL';
  end if;
  if p_reason is null or length(trim(p_reason)) < 1 or length(p_reason) > 500 then
    raise exception using errcode = '22023', message = 'INVALID_REASON';
  end if;
  if p_password_algorithm <> 'scrypt' or coalesce(length(p_password_hash), 0) < 40 or length(p_password_hash) > 512 then
    raise exception using errcode = '22023', message = 'INVALID_CREDENTIAL_MATERIAL';
  end if;
  select * into target from public.users where id = p_user_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'USER_NOT_FOUND'; end if;
  if not target.active then raise exception using errcode = 'P0001', message = 'ACTIVE_USER_REQUIRED'; end if;
  if exists (select 1 from public.admin_credentials credentials where credentials.user_id = p_user_id) then
    raise exception using errcode = 'P0001', message = 'LOGIN_ALREADY_ENABLED';
  end if;
  insert into public.admin_credentials
    (user_id, email, password_algorithm, password_hash, password_change_required)
  values (p_user_id, p_email, p_password_algorithm, p_password_hash, true);
  insert into public.audit_logs
    (actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source)
  values ('USER', p_actor_user_id, 'ADMIN_LOGIN_GRANTED', 'ADMIN_CREDENTIAL', p_user_id::text, null,
    jsonb_build_object('has_login', true, 'password_change_required', true, 'reason', trim(p_reason)),
    'admin_user_management_api');
  return p_user_id;
end;
$$;

create function public.update_admin_user_profile(
  p_user_id bigint, p_display_name text, p_actor_user_id bigint
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  previous_name text;
begin
  perform pg_advisory_xact_lock(hashtextextended('gwens_system_admin_invariant', 0));
  perform public.assert_it_system_admin(p_actor_user_id);
  if p_display_name is null or length(trim(p_display_name)) < 1 or length(trim(p_display_name)) > 120
     or p_display_name ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023', message = 'INVALID_DISPLAY_NAME';
  end if;
  select display_name into previous_name from public.users where id = p_user_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'USER_NOT_FOUND'; end if;
  update public.users set display_name = trim(p_display_name) where id = p_user_id;
  if previous_name is distinct from trim(p_display_name) then
    insert into public.audit_logs
      (actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source)
    values ('USER', p_actor_user_id, 'USER_PROFILE_UPDATED', 'USER', p_user_id::text,
      jsonb_build_object('display_name', previous_name), jsonb_build_object('display_name', trim(p_display_name)),
      'admin_user_management_api');
  end if;
  return p_user_id;
end;
$$;

create function public._apply_managed_user_access(
  p_user_id bigint, p_division_id bigint, p_role_id bigint, p_active boolean,
  p_actor_user_id bigint, p_source text, p_confirm boolean, p_reason text
)
returns setof public.users
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_user public.users%rowtype;
  updated_user public.users%rowtype;
  division_row public.divisions%rowtype;
  role_row public.roles%rowtype;
  current_division_code text;
  current_role_code text;
  target_division_code text;
  target_role_code text;
  target_division_capable boolean := false;
  sessions_revoked integer := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended('gwens_system_admin_invariant', 0));
  perform public.assert_it_system_admin(p_actor_user_id);
  if p_source is null or length(trim(p_source)) = 0 then
    raise exception using errcode = '22023', message = 'Audit source is required';
  end if;
  select * into existing_user from public.users where id = p_user_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Normalized user not found'; end if;

  if p_division_id is not null then
    select * into division_row from public.divisions where id = p_division_id;
    if not found then raise exception using errcode = '23503', message = 'Division not found'; end if;
    if p_division_id is distinct from existing_user.division_id and not division_row.active then
      raise exception using errcode = 'P0001', message = 'Disabled division cannot be newly assigned';
    end if;
    target_division_code := division_row.code;
    target_division_capable := division_row.active and division_row.grants_system_authority;
  end if;
  if p_role_id is not null then
    select * into role_row from public.roles where id = p_role_id;
    if not found then raise exception using errcode = '23503', message = 'Role not found'; end if;
    if p_role_id is distinct from existing_user.role_id and not role_row.active then
      raise exception using errcode = 'P0001', message = 'Disabled role cannot be newly assigned';
    end if;
    target_role_code := role_row.code;
  end if;
  if p_active and (p_division_id is null or p_role_id is null) then
    raise exception using errcode = '23514', message = 'Active user requires division and role';
  end if;
  if p_actor_user_id = p_user_id and not p_active then
    raise exception using errcode = '42501', message = 'SELF_DEACTIVATION_FORBIDDEN';
  end if;
  if p_actor_user_id = p_user_id and public.is_effective_system_admin(p_user_id)
     and not target_division_capable then
    if not p_confirm or p_reason is null or length(trim(p_reason)) < 1 or length(p_reason) > 500 then
      raise exception using errcode = 'P0001', message = 'SELF_DEMOTION_CONFIRMATION_REQUIRED';
    end if;
  end if;

  select divisions.code into current_division_code from public.divisions divisions where divisions.id = existing_user.division_id;
  select roles.code into current_role_code from public.roles roles where roles.id = existing_user.role_id;
  update public.users set division_id = p_division_id, role_id = p_role_id, active = p_active
  where id = p_user_id returning * into updated_user;

  if existing_user.legacy_telegram_user_id is not null then
    update public.telegram_users set
      division = coalesce(division_row.name, public.legacy_division_value(target_division_code), 'UNASSIGNED'),
      role = coalesce(role_row.name, public.legacy_role_value(target_role_code), 'UNASSIGNED'),
      active = p_active
    where id = existing_user.legacy_telegram_user_id;
    if not found then raise exception using errcode = 'P0002', message = 'Legacy user not found'; end if;
  end if;

  if existing_user.division_id is distinct from p_division_id then
    insert into public.audit_logs (actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source)
    values ('USER', p_actor_user_id, 'USER_DIVISION_CHANGED', 'USER', p_user_id::text,
      jsonb_build_object('division_code', current_division_code),
      jsonb_build_object('division_code', target_division_code, 'reason', p_reason), trim(p_source));
  end if;
  if existing_user.role_id is distinct from p_role_id then
    insert into public.audit_logs (actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source)
    values ('USER', p_actor_user_id, 'USER_ROLE_CHANGED', 'USER', p_user_id::text,
      jsonb_build_object('role_code', current_role_code), jsonb_build_object('role_code', target_role_code), trim(p_source));
  end if;
  if existing_user.active is distinct from p_active then
    insert into public.audit_logs (actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source)
    values ('USER', p_actor_user_id, case when p_active then 'USER_ACTIVATED' else 'USER_DEACTIVATED' end,
      'USER', p_user_id::text, jsonb_build_object('active', existing_user.active),
      jsonb_build_object('active', p_active), trim(p_source));
  end if;
  if existing_user.active and not p_active then
    update public.admin_sessions set revoked_at = now(), revoked_reason = 'REVOKED_BY_ADMIN'
    where user_id = p_user_id and revoked_at is null;
    get diagnostics sessions_revoked = row_count;
    if sessions_revoked > 0 then
      insert into public.audit_logs
        (actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source)
      values ('USER', p_actor_user_id, 'ADMIN_SESSION_REVOKED', 'ADMIN_SESSION', p_user_id::text, null,
        jsonb_build_object('reason', 'REVOKED_BY_ADMIN', 'count', sessions_revoked), 'admin_user_management_api');
    end if;
  end if;
  return next updated_user;
  return;
end;
$$;

create function public.update_managed_user_access(
  p_user_id bigint, p_division_id bigint, p_role_id bigint, p_active boolean,
  p_actor_user_id bigint, p_source text, p_confirm boolean, p_reason text
)
returns setof public.users
language sql
security definer
set search_path = ''
as $$
  select * from public._apply_managed_user_access(
    p_user_id, p_division_id, p_role_id, p_active, p_actor_user_id, p_source, p_confirm, p_reason
  );
$$;

create or replace function public.update_user_access(
  p_user_id bigint, p_division_id bigint, p_role_id bigint, p_active boolean,
  p_actor_user_id bigint default null, p_source text default 'admin_api_shared_key'
)
returns setof public.users
language sql
security definer
set search_path = ''
as $$
  select * from public._apply_managed_user_access(
    p_user_id, p_division_id, p_role_id, p_active, p_actor_user_id, p_source, false, null
  );
$$;

revoke all on function public.validate_admin_session(text, integer, integer) from public, anon, authenticated;
revoke all on function public.change_admin_password(bigint, text, text, bigint, uuid) from public, anon, authenticated;
revoke all on function public.list_managed_admin_users(bigint, text, text, bigint, boolean, boolean, integer, timestamptz, bigint) from public, anon, authenticated;
revoke all on function public.create_administrator_account(text, text, bigint, bigint, boolean, text, text, text, bigint) from public, anon, authenticated;
revoke all on function public.grant_admin_login(bigint, text, text, text, text, bigint) from public, anon, authenticated;
revoke all on function public.update_admin_user_profile(bigint, text, bigint) from public, anon, authenticated;
revoke all on function public._apply_managed_user_access(bigint, bigint, bigint, boolean, bigint, text, boolean, text) from public, anon, authenticated, service_role;
revoke all on function public.update_managed_user_access(bigint, bigint, bigint, boolean, bigint, text, boolean, text) from public, anon, authenticated;
revoke all on function public.update_user_access(bigint, bigint, bigint, boolean, bigint, text) from public, anon, authenticated;

grant execute on function public.validate_admin_session(text, integer, integer) to service_role;
grant execute on function public.change_admin_password(bigint, text, text, bigint, uuid) to service_role;
grant execute on function public.list_managed_admin_users(bigint, text, text, bigint, boolean, boolean, integer, timestamptz, bigint) to service_role;
grant execute on function public.create_administrator_account(text, text, bigint, bigint, boolean, text, text, text, bigint) to service_role;
grant execute on function public.grant_admin_login(bigint, text, text, text, text, bigint) to service_role;
grant execute on function public.update_admin_user_profile(bigint, text, bigint) to service_role;
grant execute on function public.update_managed_user_access(bigint, bigint, bigint, boolean, bigint, text, boolean, text) to service_role;
grant execute on function public.update_user_access(bigint, bigint, bigint, boolean, bigint, text) to service_role;

comment on column public.admin_credentials.password_change_required is
  'True only for one-time administrator credentials that must be changed before normal admin use.';
comment on function public.create_administrator_account(text, text, bigint, bigint, boolean, text, text, text, bigint) is
  'Atomically creates a login-capable administrator without creating Telegram identity state.';
comment on function public.update_managed_user_access(bigint, bigint, bigint, boolean, bigint, text, boolean, text) is
  'Session-actor-attributed access mutation with self-protection, P2-00 invariant, and atomic session revocation.';

commit;
