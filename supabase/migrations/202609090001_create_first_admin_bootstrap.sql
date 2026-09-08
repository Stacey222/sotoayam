begin;

create table public.admin_credentials (
  user_id bigint primary key references public.users (id),
  email text not null
    check (
      email = lower(trim(email))
      and length(email) between 3 and 254
      and email !~ '[[:space:][:cntrl:]]'
      and email ~ '^[^@]+@[^@.]+(\.[^@.]+)+$'
    ),
  password_algorithm text not null check (password_algorithm in ('scrypt')),
  password_hash text not null check (length(password_hash) between 40 and 512),
  password_updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index admin_credentials_email_uidx
  on public.admin_credentials (lower(email));

drop trigger if exists set_admin_credentials_updated_at on public.admin_credentials;
create trigger set_admin_credentials_updated_at
before update on public.admin_credentials
for each row execute function public.set_governance_updated_at();

alter table public.admin_credentials enable row level security;

create table public.instance_bootstrap (
  singleton smallint primary key default 1 check (singleton = 1),
  first_admin_user_id bigint not null unique references public.users (id),
  completed_at timestamptz not null default now(),
  source text not null check (length(trim(source)) > 0)
);

alter table public.instance_bootstrap enable row level security;

create or replace function public.bootstrap_first_admin(
  p_display_name text,
  p_email text,
  p_password_algorithm text,
  p_password_hash text
)
returns table (user_id bigint, assignment_id bigint, bootstrapped_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  administrative_division_id bigint;
  administrative_role_id bigint;
  normalized_email text;
  created_user_id bigint;
  created_assignment_id bigint;
  created_at timestamptz;
begin
  normalized_email := lower(trim(coalesce(p_email, '')));
  if coalesce(trim(p_display_name), '') = ''
     or length(trim(p_display_name)) > 120
     or p_display_name ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023', message = 'INVALID_DISPLAY_NAME';
  end if;
  if normalized_email !~ '^[^@[:space:][:cntrl:]]+@[^@.[:space:][:cntrl:]]+(\.[^@.[:space:][:cntrl:]]+)+$'
     or length(normalized_email) > 254 then
    raise exception using errcode = '22023', message = 'INVALID_EMAIL';
  end if;
  if p_password_algorithm <> 'scrypt'
     or coalesce(length(p_password_hash), 0) < 40
     or length(p_password_hash) > 512 then
    raise exception using errcode = '22023', message = 'INVALID_CREDENTIAL_MATERIAL';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('gwens_system_admin_invariant', 0));

  if exists (select 1 from public.instance_bootstrap)
     or exists (select 1 from public.system_authority_assignments)
     or exists (select 1 from public.admin_credentials) then
    raise exception using errcode = 'P0001', message = 'FIRST_ADMIN_ALREADY_EXISTS';
  end if;

  select divisions.id into administrative_division_id
  from public.divisions as divisions
  where divisions.code = 'IT';
  select roles.id into administrative_role_id
  from public.roles as roles
  where roles.code = 'ADMIN';
  if administrative_division_id is null or administrative_role_id is null then
    raise exception using errcode = 'P0002', message = 'TAXONOMY_UNAVAILABLE';
  end if;

  insert into public.users (display_name, division_id, role_id, active, legacy_telegram_user_id)
  values (trim(p_display_name), administrative_division_id, administrative_role_id, true, null)
  returning id into created_user_id;

  insert into public.admin_credentials (user_id, email, password_algorithm, password_hash)
  values (created_user_id, normalized_email, p_password_algorithm, p_password_hash);

  insert into public.system_authority_assignments
    (user_id, authority_code, granted_by_user_id, reason)
  values (
    created_user_id,
    'SYSTEM_ADMIN',
    null,
    'First administrator created by installation bootstrap'
  )
  returning id into created_assignment_id;

  insert into public.instance_bootstrap (singleton, first_admin_user_id, source)
  values (1, created_user_id, 'first_admin_bootstrap')
  returning completed_at into created_at;

  insert into public.audit_logs
    (actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source)
  values (
    'SYSTEM',
    null,
    'FIRST_ADMIN_BOOTSTRAPPED',
    'USER',
    created_user_id::text,
    null,
    jsonb_build_object(
      'user_id', created_user_id,
      'authority_code', 'SYSTEM_ADMIN',
      'assignment_id', created_assignment_id,
      'division_code', 'IT',
      'role_code', 'ADMIN',
      'credential_algorithm', p_password_algorithm,
      'telegram_identity_present', false
    ),
    'first_admin_bootstrap'
  );

  return query select created_user_id, created_assignment_id, created_at;
end;
$$;

revoke all on function public.bootstrap_first_admin(text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.bootstrap_first_admin(text, text, text, text) to service_role;

comment on table public.admin_credentials is
  'Service-only administrator credentials. Plaintext passwords are forbidden.';
comment on table public.instance_bootstrap is
  'Permanent single-row record proving first-administrator bootstrap completed.';
comment on function public.bootstrap_first_admin(text, text, text, text) is
  'Service-only, exactly-once transactional creation of the first administrator.';

commit;
