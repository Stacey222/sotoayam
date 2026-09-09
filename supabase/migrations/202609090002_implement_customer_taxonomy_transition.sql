begin;

create table public.installation_provenance (
  singleton smallint primary key default 1 check (singleton = 1),
  lineage text not null check (lineage in ('FRESH', 'LEGACY')),
  declared_at timestamptz not null default now(),
  declaration_source text not null check (declaration_source = 'setup_cli'),
  evidence jsonb not null check (jsonb_typeof(evidence) = 'object'),
  origin_seed_retired_at timestamptz,
  origin_seed_retired_count integer,
  check (
    (lineage = 'FRESH' and origin_seed_retired_at is not null and origin_seed_retired_count = 10)
    or (lineage = 'LEGACY' and origin_seed_retired_at is null and origin_seed_retired_count is null)
  )
);

create table public.task_categories (
  id bigint generated always as identity primary key,
  code text not null unique check (code ~ '^[A-Z][A-Z0-9_]{0,49}$'),
  name text not null check (length(trim(name)) between 1 and 120),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_task_categories_updated_at
before update on public.task_categories
for each row execute function public.set_governance_updated_at();

create or replace function public.prevent_taxonomy_code_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.code is distinct from old.code then
    raise exception using errcode = 'P0001', message = 'Taxonomy code is immutable';
  end if;
  return new;
end;
$$;

create trigger prevent_division_code_change
before update of code on public.divisions
for each row execute function public.prevent_taxonomy_code_change();

create trigger prevent_task_category_code_change
before update of code on public.task_categories
for each row execute function public.prevent_taxonomy_code_change();

alter table public.installation_provenance enable row level security;
alter table public.task_categories enable row level security;
revoke all on table public.installation_provenance from public, anon, authenticated;
revoke insert, update, delete on table public.installation_provenance from service_role;
grant select on table public.installation_provenance to service_role;
revoke all on table public.task_categories from public, anon, authenticated;
grant select on table public.task_categories to service_role;

alter table public.divisions
  add column grants_system_authority boolean not null default false,
  add column provisioning_source text
    check (provisioning_source is null or provisioning_source in ('CUSTOMER', 'PRESET', 'SETUP'));

alter table public.roles
  add column system_managed boolean not null default false;

insert into public.permissions (code, name)
values ('alert.acknowledge', 'Acknowledge critical alerts')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select roles.id, permissions.id
from public.roles roles
join public.permissions permissions on permissions.code = 'alert.acknowledge'
where roles.code = 'OWNER'
on conflict (role_id, permission_id) do nothing;

update public.roles
set system_managed = true
where code in ('STAFF', 'ADMIN', 'OWNER');

-- Compatibility grant only. It executes before any predicate is replaced and is not retirement.
update public.divisions
set grants_system_authority = true
where code = 'IT';

create or replace function public.prevent_installation_provenance_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001', message = 'Installation provenance is append-only';
end;
$$;

create trigger prevent_installation_provenance_update_or_delete
before update or delete on public.installation_provenance
for each row execute function public.prevent_installation_provenance_mutation();

create or replace function public.guard_division_authority_capability_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare table_owner name;
begin
  select roles.rolname into table_owner
  from pg_catalog.pg_class relations
  join pg_catalog.pg_namespace namespaces on namespaces.oid = relations.relnamespace
  join pg_catalog.pg_roles roles on roles.oid = relations.relowner
  where namespaces.nspname = 'public' and relations.relname = 'divisions';

  if ((tg_op = 'INSERT' and new.grants_system_authority)
      or (tg_op = 'UPDATE' and new.grants_system_authority is distinct from old.grants_system_authority))
     and current_user <> table_owner then
    raise exception using errcode = '42501', message = 'Division authority capability requires an owner SECURITY DEFINER path';
  end if;
  return new;
end;
$$;

create trigger guard_division_authority_capability
before insert or update of grants_system_authority on public.divisions
for each row execute function public.guard_division_authority_capability_write();

create or replace function public.protect_last_authority_capability_division()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare removes_capability boolean := false;
begin
  if tg_op = 'DELETE' then
    removes_capability := old.active and old.grants_system_authority;
  else
    removes_capability := old.active and old.grants_system_authority
      and (not new.active or not new.grants_system_authority);
  end if;

  if removes_capability
     and (exists (select 1 from public.instance_bootstrap)
       or exists (select 1 from public.system_authority_assignments))
  then
    perform pg_advisory_xact_lock(hashtextextended('gwens_system_admin_invariant', 0));
    if not exists (
      select 1 from public.divisions divisions
      where divisions.id <> old.id and divisions.active and divisions.grants_system_authority
    ) then
      raise exception using errcode = 'P0001', message = 'Final authority-capable division cannot be removed';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger protect_last_authority_capability_update
before update of active, grants_system_authority on public.divisions
for each row execute function public.protect_last_authority_capability_division();

create trigger protect_last_authority_capability_delete
before delete on public.divisions
for each row execute function public.protect_last_authority_capability_division();

create or replace function public.protect_reserved_role()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.system_managed and (tg_op = 'DELETE'
      or (tg_op = 'UPDATE' and (new.code is distinct from old.code
        or new.active is distinct from true
        or new.system_managed is distinct from true))) then
    raise exception using errcode = 'P0001', message = 'Reserved role code, lifecycle, and ownership are immutable';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger protect_reserved_role_lifecycle
before update or delete on public.roles
for each row execute function public.protect_reserved_role();

create or replace function public.is_system_authority_candidate(p_user_id bigint)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.users users
    join public.divisions divisions on divisions.id = users.division_id
    where users.id = p_user_id
      and users.active
      and divisions.active
      and divisions.grants_system_authority
  );
$$;

create or replace function public.validate_system_admin_candidate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.authority_code = 'SYSTEM_ADMIN' and new.revoked_at is null
     and not public.is_system_authority_candidate(new.user_id) then
    raise exception using errcode = 'P0001', message = 'SYSTEM_ADMIN candidate must be active in an authority-capable division';
  end if;
  return new;
end;
$$;

create or replace function public.protect_final_system_admin_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_is_capable boolean := false;
  active_authority_count bigint;
begin
  select divisions.active and divisions.grants_system_authority into target_is_capable
  from public.divisions divisions where divisions.id = new.division_id;
  if exists (
    select 1 from public.system_authority_assignments assignments
    where assignments.user_id = old.id and assignments.authority_code = 'SYSTEM_ADMIN' and assignments.revoked_at is null
  ) and (not new.active or not coalesce(target_is_capable, false)) then
    perform pg_advisory_xact_lock(hashtextextended('gwens_system_admin_invariant', 0));
    select count(*) into active_authority_count from public.system_authority_assignments assignments
    where assignments.authority_code = 'SYSTEM_ADMIN' and assignments.revoked_at is null;
    if active_authority_count <= 1 then
      raise exception using errcode = 'P0001', message = 'Final active SYSTEM_ADMIN must remain in an authority-capable division until handover';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.update_user_access(
  p_user_id bigint,
  p_division_id bigint,
  p_role_id bigint,
  p_active boolean,
  p_actor_user_id bigint default null,
  p_source text default 'admin_api_shared_key'
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
  active_authority_count bigint;
begin
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

  select divisions.code into current_division_code from public.divisions divisions where divisions.id = existing_user.division_id;
  select roles.code into current_role_code from public.roles roles where roles.id = existing_user.role_id;

  if exists (
    select 1 from public.system_authority_assignments assignments
    where assignments.user_id = p_user_id and assignments.authority_code = 'SYSTEM_ADMIN' and assignments.revoked_at is null
  ) and (not p_active or not target_division_capable) then
    perform pg_advisory_xact_lock(hashtextextended('gwens_system_admin_invariant', 0));
    select count(*) into active_authority_count from public.system_authority_assignments assignments
    where assignments.authority_code = 'SYSTEM_ADMIN' and assignments.revoked_at is null;
    if active_authority_count <= 1 then
      raise exception using errcode = 'P0001', message = 'Final active SYSTEM_ADMIN must remain in an authority-capable division until handover';
    end if;
  end if;

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
    values (case when p_actor_user_id is null then 'SYSTEM' else 'USER' end, p_actor_user_id,
      'USER_DIVISION_CHANGED', 'USER', p_user_id::text,
      jsonb_build_object('division_code', current_division_code), jsonb_build_object('division_code', target_division_code), trim(p_source));
  end if;
  if existing_user.role_id is distinct from p_role_id then
    insert into public.audit_logs (actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source)
    values (case when p_actor_user_id is null then 'SYSTEM' else 'USER' end, p_actor_user_id,
      'USER_ROLE_CHANGED', 'USER', p_user_id::text,
      jsonb_build_object('role_code', current_role_code), jsonb_build_object('role_code', target_role_code), trim(p_source));
  end if;
  if existing_user.active is distinct from p_active then
    insert into public.audit_logs (actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source)
    values (case when p_actor_user_id is null then 'SYSTEM' else 'USER' end, p_actor_user_id,
      case when p_active then 'USER_ACTIVATED' else 'USER_DEACTIVATED' end, 'USER', p_user_id::text,
      jsonb_build_object('active', existing_user.active), jsonb_build_object('active', p_active), trim(p_source));
  end if;
  return next updated_user;
  return;
end;
$$;

create or replace function public.assign_system_admin(p_user_id bigint, p_reason text, p_actor_user_id bigint default null)
returns setof public.system_authority_assignments
language plpgsql
security definer
set search_path = ''
as $$
declare assignment public.system_authority_assignments%rowtype;
begin
  if p_reason is null or length(trim(p_reason)) = 0 or length(p_reason) > 500 then
    raise exception using errcode = '22023', message = 'Reason must contain 1-500 characters';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('gwens_system_admin_invariant', 0));
  if not public.is_system_authority_candidate(p_user_id) then
    raise exception using errcode = 'P0001', message = 'SYSTEM_ADMIN candidate must be active in an authority-capable division';
  end if;
  select * into assignment from public.system_authority_assignments
  where user_id = p_user_id and authority_code = 'SYSTEM_ADMIN' and revoked_at is null;
  if found then return next assignment; return; end if;
  insert into public.system_authority_assignments (user_id, authority_code, granted_by_user_id, reason)
  values (p_user_id, 'SYSTEM_ADMIN', p_actor_user_id, trim(p_reason)) returning * into assignment;
  insert into public.audit_logs (actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source)
  values (case when p_actor_user_id is null then 'SYSTEM' else 'USER' end, p_actor_user_id,
    'SYSTEM_ADMIN_GRANTED', 'SYSTEM_AUTHORITY_ASSIGNMENT', assignment.id::text, null,
    jsonb_build_object('user_id', p_user_id, 'authority_code', 'SYSTEM_ADMIN', 'reason', trim(p_reason)), 'admin_api_shared_key');
  return next assignment;
  return;
end;
$$;

create or replace function public.assert_it_system_admin(p_actor_user_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_system_authority_candidate(p_actor_user_id) or not exists (
    select 1 from public.system_authority_assignments authority
    where authority.user_id = p_actor_user_id and authority.authority_code = 'SYSTEM_ADMIN' and authority.revoked_at is null
  ) then
    raise exception using errcode = '42501', message = 'Active SYSTEM_ADMIN authority in an authority-capable division is required';
  end if;
end;
$$;

create or replace function public._set_division_system_authority(p_division_id bigint, p_enabled boolean)
returns public.divisions
language plpgsql
security definer
set search_path = ''
as $$
declare result public.divisions%rowtype;
begin
  update public.divisions set grants_system_authority = p_enabled
  where id = p_division_id returning * into result;
  if result.id is null then raise exception using errcode = 'P0002', message = 'Division not found'; end if;
  return result;
end;
$$;

create or replace function public.set_division_system_authority(
  p_division_id bigint, p_enabled boolean, p_actor_user_id bigint, p_source text
)
returns public.divisions
language plpgsql
security definer
set search_path = ''
as $$
declare existing public.divisions%rowtype; result public.divisions%rowtype;
begin
  perform public.assert_it_system_admin(p_actor_user_id);
  if coalesce(length(trim(p_source)), 0) = 0 then raise exception using errcode = '22023', message = 'Audit source is required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('gwens_system_admin_invariant', 0));
  select * into existing from public.divisions where id = p_division_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Division not found'; end if;
  if existing.grants_system_authority = p_enabled then return existing; end if;
  if not p_enabled and existing.active
     and (exists (select 1 from public.instance_bootstrap) or exists (select 1 from public.system_authority_assignments))
     and not exists (select 1 from public.divisions where id <> p_division_id and active and grants_system_authority) then
    raise exception using errcode = 'P0001', message = 'DIVISION_AUTHORITY_REQUIRED';
  end if;
  result := public._set_division_system_authority(p_division_id, p_enabled);
  insert into public.audit_logs (actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source)
  values ('USER', p_actor_user_id, 'DIVISION_AUTHORITY_CAPABILITY_CHANGED', 'DIVISION', p_division_id::text,
    jsonb_build_object('grants_system_authority', existing.grants_system_authority),
    jsonb_build_object('grants_system_authority', result.grants_system_authority), trim(p_source));
  return result;
end;
$$;

create or replace function public.acknowledge_critical_alert(p_alert_id bigint, p_actor_user_id bigint)
returns public.critical_alerts
language plpgsql
security definer
set search_path = ''
as $$
declare result public.critical_alerts%rowtype; previous_status text;
begin
  if not exists (
    select 1 from public.users users
    join public.roles roles on roles.id = users.role_id
    join public.role_permissions grants on grants.role_id = roles.id
    join public.permissions permissions on permissions.id = grants.permission_id
    where users.id = p_actor_user_id and users.active and roles.active
      and permissions.active and permissions.code = 'alert.acknowledge'
  ) then raise exception using errcode = '42501', message = 'Critical alert acknowledgment permission is required'; end if;
  select status into previous_status from public.critical_alerts where id = p_alert_id and status in ('OPEN', 'ACKNOWLEDGED') for update;
  update public.critical_alerts set status = 'ACKNOWLEDGED', acknowledged_at = coalesce(acknowledged_at, now()),
    acknowledged_by_user_id = coalesce(acknowledged_by_user_id, p_actor_user_id)
  where id = p_alert_id and status in ('OPEN', 'ACKNOWLEDGED') returning * into result;
  if result.id is null then raise exception using errcode = 'P0002', message = 'Active critical alert not found'; end if;
  if previous_status = 'OPEN' then
    insert into public.audit_logs (actor_type, actor_user_id, action, object_type, object_id, after_state, source)
    values ('USER', p_actor_user_id, 'CRITICAL_ALERT_ACKNOWLEDGED', 'CRITICAL_ALERT', result.id::text,
      jsonb_build_object('status', result.status), 'critical_alert_api');
  end if;
  return result;
end;
$$;

create or replace function public._create_first_admin(
  p_display_name text, p_email text, p_password_algorithm text, p_password_hash text, p_division_id bigint
)
returns table (user_id bigint, assignment_id bigint, bootstrapped_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare administrative_role_id bigint; normalized_email text; created_user_id bigint; created_assignment_id bigint; division_code text;
begin
  normalized_email := lower(trim(coalesce(p_email, '')));
  if coalesce(trim(p_display_name), '') = '' or length(trim(p_display_name)) > 120 then
    raise exception using errcode = '22023', message = 'INVALID_DISPLAY_NAME';
  end if;
  if normalized_email !~ '^[^@[:space:][:cntrl:]]+@[^@.[:space:][:cntrl:]]+(\.[^@.[:space:][:cntrl:]]+)+$' or length(normalized_email) > 254 then
    raise exception using errcode = '22023', message = 'INVALID_EMAIL';
  end if;
  if p_password_algorithm <> 'scrypt' or coalesce(length(p_password_hash), 0) < 40 then
    raise exception using errcode = '22023', message = 'INVALID_CREDENTIAL_MATERIAL';
  end if;
  select code into division_code from public.divisions where id = p_division_id and active and grants_system_authority;
  select id into administrative_role_id from public.roles where code = 'ADMIN' and active and system_managed;
  if division_code is null or administrative_role_id is null then
    raise exception using errcode = 'P0002', message = 'TAXONOMY_UNAVAILABLE';
  end if;
  insert into public.users (display_name, division_id, role_id, active, legacy_telegram_user_id)
  values (trim(p_display_name), p_division_id, administrative_role_id, true, null) returning id into created_user_id;
  insert into public.admin_credentials (user_id, email, password_algorithm, password_hash)
  values (created_user_id, normalized_email, p_password_algorithm, p_password_hash);
  insert into public.system_authority_assignments (user_id, authority_code, granted_by_user_id, reason)
  values (created_user_id, 'SYSTEM_ADMIN', null, 'First administrator created by installation bootstrap')
  returning id into created_assignment_id;
  return query select created_user_id, created_assignment_id, now();
end;
$$;

create or replace function public.bootstrap_first_admin(
  p_display_name text, p_email text, p_password_algorithm text, p_password_hash text
)
returns table (user_id bigint, assignment_id bigint, bootstrapped_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare administrative_division_id bigint; candidate_count bigint; created_admin record; resolved_division_code text;
begin
  perform pg_advisory_xact_lock(hashtextextended('gwens_system_admin_invariant', 0));
  if exists (select 1 from public.instance_bootstrap)
     or exists (select 1 from public.system_authority_assignments)
     or exists (select 1 from public.admin_credentials) then
    raise exception using errcode = 'P0001', message = 'FIRST_ADMIN_ALREADY_EXISTS';
  end if;
  select count(*), min(id) into candidate_count, administrative_division_id
  from public.divisions where active and grants_system_authority;
  if candidate_count <> 1 then raise exception using errcode = 'P0002', message = 'TAXONOMY_UNAVAILABLE'; end if;
  select code into resolved_division_code from public.divisions where id = administrative_division_id;
  select * into created_admin from public._create_first_admin(
    p_display_name, p_email, p_password_algorithm, p_password_hash, administrative_division_id
  );
  insert into public.instance_bootstrap (singleton, first_admin_user_id, source)
  values (1, created_admin.user_id, 'first_admin_bootstrap');
  insert into public.audit_logs (actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source)
  values ('SYSTEM', null, 'FIRST_ADMIN_BOOTSTRAPPED', 'USER', created_admin.user_id::text, null,
    jsonb_build_object('user_id', created_admin.user_id, 'authority_code', 'SYSTEM_ADMIN',
      'assignment_id', created_admin.assignment_id, 'division_code', resolved_division_code,
      'role_code', 'ADMIN', 'credential_algorithm', p_password_algorithm,
      'telegram_identity_present', false), 'first_admin_bootstrap');
  return query select created_admin.user_id, created_admin.assignment_id, created_admin.bootstrapped_at;
end;
$$;

create or replace function public.preview_first_admin_setup(p_lineage text)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare result jsonb;
begin
  if p_lineage not in ('FRESH', 'LEGACY') then raise exception using errcode = '22023', message = 'INVALID_INSTALLATION_LINEAGE'; end if;
  select jsonb_build_object(
    'lineage', p_lineage,
    'eligible', not exists (select 1 from public.instance_bootstrap)
      and not exists (select 1 from public.system_authority_assignments)
      and not exists (select 1 from public.admin_credentials)
      and not exists (select 1 from public.installation_provenance),
    'evidence', jsonb_build_object(
      'users', (select count(*) from public.users),
      'telegram_users', (select count(*) from public.telegram_users),
      'tasks', (select count(*) from public.tasks),
      'system_authority_assignments', (select count(*) from public.system_authority_assignments),
      'admin_credentials', (select count(*) from public.admin_credentials),
      'instance_bootstrap', (select count(*) from public.instance_bootstrap),
      'non_migration_seed_audit_logs', (select count(*) from public.audit_logs where source <> 'migration_seed'),
      'extra_or_modified_seed_divisions', (
        select count(*) from public.divisions divisions
        where not (divisions.active and divisions.provisioning_source is null and (divisions.code, divisions.name) in (
          ('PURCHASING','Purchasing'), ('SALES_GROSIR','Sales Grosir'), ('DIGITAL_MARKETING','Digital Marketing'),
          ('CONTENT_CREATOR','Content Creator'), ('ONPAGE_B2C','On Page / B2C'), ('SHOPEE_LIVE','Shopee Live'),
          ('GUDANG','Gudang'), ('MANAGEMENT','Management'), ('IT','IT')
        ))
      ),
      'non_origin_collaboration_rules', (
        select count(*) from public.division_collaboration_rules rules
        join public.divisions source on source.id = rules.source_division_id
        join public.divisions target on target.id = rules.target_division_id
        where not (source.code = 'ONPAGE_B2C' and source.name = 'On Page / B2C'
          and target.code = 'CONTENT_CREATOR' and target.name = 'Content Creator'
          and rules.task_scope = 'ALL' and rules.allowed and not rules.requires_approval and rules.active)
      ),
      'users_division_refs', (select count(*) from public.users where division_id is not null),
      'task_requesting_division_refs', (select count(*) from public.tasks where requesting_division_id is not null),
      'task_owner_division_refs', (select count(*) from public.tasks where owner_division_id is not null),
      'collaboration_source_division_refs', (select count(*) from public.division_collaboration_rules),
      'collaboration_target_division_refs', (select count(*) from public.division_collaboration_rules),
      'integration_requesting_division_refs', (select count(*) from public.task_source_integrations where requesting_division_id is not null),
      'routing_owner_division_refs', (select count(*) from public.notification_routing_rules where owner_division_id is not null),
      'alert_owner_division_refs', (select count(*) from public.critical_alerts where owner_division_id is not null)
    ),
    'retirement_divisions', case when p_lineage = 'FRESH' then (
      select coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name) order by code), '[]'::jsonb)
      from public.divisions where active and provisioning_source is null and (code, name) in (
        ('PURCHASING','Purchasing'), ('SALES_GROSIR','Sales Grosir'), ('DIGITAL_MARKETING','Digital Marketing'),
        ('CONTENT_CREATOR','Content Creator'), ('ONPAGE_B2C','On Page / B2C'), ('SHOPEE_LIVE','Shopee Live'),
        ('GUDANG','Gudang'), ('MANAGEMENT','Management'), ('IT','IT')
      )
    ) else '[]'::jsonb end,
    'retirement_rule', case when p_lineage = 'FRESH' then (
      select jsonb_build_object(
        'source_division_code', source.code,
        'target_division_code', target.code,
        'task_scope', rules.task_scope,
        'allowed', rules.allowed,
        'requires_approval', rules.requires_approval,
        'active', rules.active
      )
      from public.division_collaboration_rules rules
      join public.divisions source on source.id = rules.source_division_id
      join public.divisions target on target.id = rules.target_division_id
      where source.code = 'ONPAGE_B2C' and source.name = 'On Page / B2C'
        and target.code = 'CONTENT_CREATOR' and target.name = 'Content Creator'
        and rules.task_scope = 'ALL' and rules.allowed and not rules.requires_approval and rules.active
      limit 1
    ) else null end
  ) into result;
  return result;
end;
$$;

create or replace function public.provision_first_installation(
  p_display_name text, p_email text, p_password_algorithm text, p_password_hash text,
  p_lineage text, p_division_code text, p_division_name text
)
returns table (user_id bigint, assignment_id bigint, bootstrapped_at timestamptz, division_code text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_code text := upper(trim(coalesce(p_division_code, '')));
  normalized_name text := trim(coalesce(p_division_name, ''));
  resolved_division public.divisions%rowtype;
  created_admin record;
  seed_rule_id bigint;
  seed_division_count bigint;
  seed_rule_count bigint;
  disallowed_audit_count bigint;
  reference_count bigint;
  evidence_state jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('gwens_system_admin_invariant', 0));
  if p_lineage not in ('FRESH', 'LEGACY') then raise exception using errcode = '22023', message = 'INVALID_INSTALLATION_LINEAGE'; end if;
  if coalesce(trim(p_display_name), '') = '' or length(trim(p_display_name)) > 120 then
    raise exception using errcode = '22023', message = 'INVALID_DISPLAY_NAME';
  end if;
  if lower(trim(coalesce(p_email, ''))) !~ '^[^@[:space:][:cntrl:]]+@[^@.[:space:][:cntrl:]]+(\.[^@.[:space:][:cntrl:]]+)+$'
     or length(lower(trim(coalesce(p_email, '')))) > 254 then
    raise exception using errcode = '22023', message = 'INVALID_EMAIL';
  end if;
  if p_password_algorithm <> 'scrypt' or coalesce(length(p_password_hash), 0) < 40 then
    raise exception using errcode = '22023', message = 'INVALID_CREDENTIAL_MATERIAL';
  end if;
  if normalized_code !~ '^[A-Z][A-Z0-9_]*$' or length(normalized_code) > 100 then
    raise exception using errcode = '22023', message = 'INVALID_DIVISION';
  end if;
  if p_lineage = 'FRESH' and (length(normalized_name) = 0 or length(normalized_name) > 120) then
    raise exception using errcode = '22023', message = 'INVALID_DIVISION';
  end if;
  if exists (select 1 from public.instance_bootstrap)
     or exists (select 1 from public.system_authority_assignments)
     or exists (select 1 from public.admin_credentials)
     or exists (select 1 from public.installation_provenance) then
    raise exception using errcode = 'P0001', message = 'FIRST_ADMIN_ALREADY_EXISTS';
  end if;

  select jsonb_build_object(
    'users', (select count(*) from public.users),
    'telegram_users', (select count(*) from public.telegram_users),
    'tasks', (select count(*) from public.tasks),
    'system_authority_assignments', (select count(*) from public.system_authority_assignments),
    'admin_credentials', (select count(*) from public.admin_credentials),
    'instance_bootstrap', (select count(*) from public.instance_bootstrap),
    'non_migration_seed_audit_logs', (select count(*) from public.audit_logs where source <> 'migration_seed'),
    'extra_or_modified_seed_divisions', (
      select count(*) from public.divisions divisions
      where not (divisions.active and divisions.provisioning_source is null and (divisions.code, divisions.name) in (
        ('PURCHASING','Purchasing'), ('SALES_GROSIR','Sales Grosir'), ('DIGITAL_MARKETING','Digital Marketing'),
        ('CONTENT_CREATOR','Content Creator'), ('ONPAGE_B2C','On Page / B2C'), ('SHOPEE_LIVE','Shopee Live'),
        ('GUDANG','Gudang'), ('MANAGEMENT','Management'), ('IT','IT')
      ))
    ),
    'non_origin_collaboration_rules', (
      select count(*) from public.division_collaboration_rules rules
      join public.divisions source on source.id = rules.source_division_id
      join public.divisions target on target.id = rules.target_division_id
      where not (source.code = 'ONPAGE_B2C' and source.name = 'On Page / B2C'
        and target.code = 'CONTENT_CREATOR' and target.name = 'Content Creator'
        and rules.task_scope = 'ALL' and rules.allowed and not rules.requires_approval and rules.active)
    ),
    'users_division_refs', (select count(*) from public.users where division_id is not null),
    'task_requesting_division_refs', (select count(*) from public.tasks where requesting_division_id is not null),
    'task_owner_division_refs', (select count(*) from public.tasks where owner_division_id is not null),
    'collaboration_source_division_refs', (select count(*) from public.division_collaboration_rules),
    'collaboration_target_division_refs', (select count(*) from public.division_collaboration_rules),
    'integration_requesting_division_refs', (select count(*) from public.task_source_integrations where requesting_division_id is not null),
    'routing_owner_division_refs', (select count(*) from public.notification_routing_rules where owner_division_id is not null),
    'alert_owner_division_refs', (select count(*) from public.critical_alerts where owner_division_id is not null)
  ) into evidence_state;

  if p_lineage = 'FRESH' then
    if (evidence_state->>'users')::bigint <> 0 or (evidence_state->>'telegram_users')::bigint <> 0
       or (evidence_state->>'tasks')::bigint <> 0 or (evidence_state->>'non_migration_seed_audit_logs')::bigint <> 0 then
      raise exception using errcode = 'P0001', message = 'FRESH_INSTALL_EVIDENCE_VETO';
    end if;

    select count(*) into seed_division_count from public.divisions
    where active and provisioning_source is null and (code, name) in (
      ('PURCHASING','Purchasing'), ('SALES_GROSIR','Sales Grosir'), ('DIGITAL_MARKETING','Digital Marketing'),
      ('CONTENT_CREATOR','Content Creator'), ('ONPAGE_B2C','On Page / B2C'), ('SHOPEE_LIVE','Shopee Live'),
      ('GUDANG','Gudang'), ('MANAGEMENT','Management'), ('IT','IT')
    );
    if seed_division_count <> 9 or (select count(*) from public.divisions) <> 9 then
      raise exception using errcode = 'P0001', message = 'FRESH_INSTALL_SEED_MISMATCH';
    end if;

    select count(*), min(rules.id) into seed_rule_count, seed_rule_id
    from public.division_collaboration_rules rules
    join public.divisions source on source.id = rules.source_division_id
    join public.divisions target on target.id = rules.target_division_id
    where source.code = 'ONPAGE_B2C' and source.name = 'On Page / B2C'
      and target.code = 'CONTENT_CREATOR' and target.name = 'Content Creator'
      and rules.task_scope = 'ALL' and rules.allowed and not rules.requires_approval and rules.active;
    if seed_rule_count <> 1 or (select count(*) from public.division_collaboration_rules) <> 1 then
      raise exception using errcode = 'P0001', message = 'FRESH_INSTALL_SEED_MISMATCH';
    end if;

    select count(*) into reference_count from (
      select users.division_id id from public.users users
      union all select tasks.requesting_division_id from public.tasks tasks
      union all select tasks.owner_division_id from public.tasks tasks
      union all select integrations.requesting_division_id from public.task_source_integrations integrations
      union all select routing.owner_division_id from public.notification_routing_rules routing
      union all select alerts.owner_division_id from public.critical_alerts alerts where alerts.owner_division_id is not null
    ) references_to_divisions
    join public.divisions divisions on divisions.id = references_to_divisions.id;
    if reference_count <> 0 then raise exception using errcode = 'P0001', message = 'FRESH_INSTALL_REFERENCE_VETO'; end if;

    select count(*) into disallowed_audit_count from public.audit_logs logs
    where not (
      logs.actor_type = 'SYSTEM' and logs.actor_user_id is null
      and logs.source = 'migration_seed' and logs.action = 'COLLABORATION_RULE_CREATED'
      and logs.object_type = 'DIVISION_COLLABORATION_RULE' and logs.object_id = seed_rule_id::text
      and logs.before_state is null
      and logs.after_state = jsonb_build_object(
        'source_division_id', (select id from public.divisions where code = 'ONPAGE_B2C' and name = 'On Page / B2C'),
        'target_division_id', (select id from public.divisions where code = 'CONTENT_CREATOR' and name = 'Content Creator'),
        'task_scope', 'ALL', 'allowed', true, 'requires_approval', false, 'active', true
      )
    );
    if disallowed_audit_count <> 0 or (select count(*) from public.audit_logs) <> 1 then
      raise exception using errcode = 'P0001', message = 'FRESH_INSTALL_AUDIT_VETO';
    end if;

    delete from public.division_collaboration_rules where id = seed_rule_id;
    if not found then raise exception using errcode = 'P0001', message = 'FRESH_INSTALL_RETIREMENT_FAILED'; end if;
    delete from public.divisions where active and provisioning_source is null and (code, name) in (
      ('PURCHASING','Purchasing'), ('SALES_GROSIR','Sales Grosir'), ('DIGITAL_MARKETING','Digital Marketing'),
      ('CONTENT_CREATOR','Content Creator'), ('ONPAGE_B2C','On Page / B2C'), ('SHOPEE_LIVE','Shopee Live'),
      ('GUDANG','Gudang'), ('MANAGEMENT','Management'), ('IT','IT')
    );
    get diagnostics seed_division_count = row_count;
    if seed_division_count <> 9 then raise exception using errcode = 'P0001', message = 'FRESH_INSTALL_RETIREMENT_FAILED'; end if;

    insert into public.divisions (code, name, active, grants_system_authority, provisioning_source)
    values (normalized_code, normalized_name, true, false, 'SETUP') returning * into resolved_division;
  else
    if normalized_name <> '' then raise exception using errcode = '22023', message = 'INVALID_DIVISION'; end if;
    select * into resolved_division from public.divisions where code = normalized_code and active;
    if not found then raise exception using errcode = 'P0002', message = 'TAXONOMY_UNAVAILABLE'; end if;
  end if;

  resolved_division := public._set_division_system_authority(resolved_division.id, true);
  select * into created_admin from public._create_first_admin(
    p_display_name, p_email, p_password_algorithm, p_password_hash, resolved_division.id
  );

  insert into public.installation_provenance (
    singleton, lineage, declaration_source, evidence, origin_seed_retired_at, origin_seed_retired_count
  ) values (
    1, p_lineage, 'setup_cli', evidence_state,
    case when p_lineage = 'FRESH' then now() else null end,
    case when p_lineage = 'FRESH' then 10 else null end
  );

  insert into public.instance_bootstrap (singleton, first_admin_user_id, source)
  values (1, created_admin.user_id, 'first_admin_bootstrap');

  insert into public.audit_logs (actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source)
  values ('SYSTEM', null, 'FIRST_ADMIN_BOOTSTRAPPED', 'USER', created_admin.user_id::text, null,
    jsonb_build_object('user_id', created_admin.user_id, 'authority_code', 'SYSTEM_ADMIN',
      'assignment_id', created_admin.assignment_id, 'division_code', resolved_division.code,
      'role_code', 'ADMIN', 'credential_algorithm', p_password_algorithm,
      'telegram_identity_present', false), 'first_admin_bootstrap');

  if p_lineage = 'FRESH' then
    insert into public.audit_logs (actor_type, action, object_type, object_id, after_state, source)
    select 'SYSTEM', 'ORIGIN_TAXONOMY_RETIRED', 'DIVISION', seed.code,
      jsonb_build_object('code', seed.code), 'setup_origin_seed_retirement'
    from (values ('PURCHASING'),('SALES_GROSIR'),('DIGITAL_MARKETING'),('CONTENT_CREATOR'),('ONPAGE_B2C'),
      ('SHOPEE_LIVE'),('GUDANG'),('MANAGEMENT'),('IT')) seed(code);
    insert into public.audit_logs (actor_type, action, object_type, object_id, after_state, source)
    values ('SYSTEM', 'ORIGIN_TAXONOMY_RETIRED', 'DIVISION_COLLABORATION_RULE', seed_rule_id::text,
      jsonb_build_object('retired', true), 'setup_origin_seed_retirement');
  end if;
  insert into public.audit_logs (actor_type, action, object_type, object_id, after_state, source)
  values ('SYSTEM', 'INSTALLATION_PROVENANCE_DECLARED', 'INSTALLATION', '1',
    jsonb_build_object('lineage', p_lineage, 'origin_seed_retired_count', case when p_lineage = 'FRESH' then 10 else 0 end),
    'setup_cli');

  return query select created_admin.user_id, created_admin.assignment_id, created_admin.bootstrapped_at, resolved_division.code;
end;
$$;

create or replace function public.create_customer_division(
  p_code text, p_name text, p_actor_user_id bigint, p_source text
)
returns public.divisions
language plpgsql
security definer
set search_path = ''
as $$
declare result public.divisions%rowtype; normalized_code text := upper(trim(coalesce(p_code, ''))); normalized_name text := trim(coalesce(p_name, ''));
begin
  perform public.assert_it_system_admin(p_actor_user_id);
  if normalized_code !~ '^[A-Z][A-Z0-9_]*$' or length(normalized_code) > 100
     or length(normalized_name) = 0 or length(normalized_name) > 120 then
    raise exception using errcode = '22023', message = 'INVALID_DIVISION';
  end if;
  if coalesce(length(trim(p_source)), 0) = 0 then raise exception using errcode = '22023', message = 'Audit source is required'; end if;
  begin
    insert into public.divisions (code, name, active, grants_system_authority, provisioning_source)
    values (normalized_code, normalized_name, true, false, 'CUSTOMER') returning * into result;
  exception when unique_violation then
    raise exception using errcode = '23505', message = 'DIVISION_DUPLICATE_CODE';
  end;
  insert into public.audit_logs (actor_type, actor_user_id, action, object_type, object_id, after_state, source)
  values ('USER', p_actor_user_id, 'DIVISION_CREATED', 'DIVISION', result.id::text,
    jsonb_build_object('code', result.code, 'active', result.active), trim(p_source));
  return result;
end;
$$;

create or replace function public.update_customer_division(
  p_division_id bigint, p_name text, p_active boolean, p_actor_user_id bigint, p_source text
)
returns public.divisions
language plpgsql
security definer
set search_path = ''
as $$
declare existing public.divisions%rowtype; result public.divisions%rowtype; normalized_name text;
begin
  perform public.assert_it_system_admin(p_actor_user_id);
  if p_name is null and p_active is null then raise exception using errcode = '22023', message = 'INVALID_DIVISION'; end if;
  if p_name is not null then
    normalized_name := trim(p_name);
    if length(normalized_name) = 0 or length(normalized_name) > 120 then raise exception using errcode = '22023', message = 'INVALID_DIVISION'; end if;
  end if;
  if coalesce(length(trim(p_source)), 0) = 0 then raise exception using errcode = '22023', message = 'Audit source is required'; end if;
  select * into existing from public.divisions where id = p_division_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'DIVISION_NOT_FOUND'; end if;
  if p_active is false and existing.active and existing.grants_system_authority then
    perform pg_advisory_xact_lock(hashtextextended('gwens_system_admin_invariant', 0));
    if (exists (select 1 from public.instance_bootstrap) or exists (select 1 from public.system_authority_assignments))
       and not exists (select 1 from public.divisions where id <> p_division_id and active and grants_system_authority) then
      raise exception using errcode = 'P0001', message = 'DIVISION_AUTHORITY_REQUIRED';
    end if;
  end if;
  update public.divisions set name = coalesce(normalized_name, name), active = coalesce(p_active, active)
  where id = p_division_id returning * into result;
  insert into public.audit_logs (actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source)
  values ('USER', p_actor_user_id, 'DIVISION_UPDATED', 'DIVISION', result.id::text,
    jsonb_build_object('name', existing.name, 'active', existing.active),
    jsonb_build_object('name', result.name, 'active', result.active), trim(p_source));
  return result;
end;
$$;

create or replace function public.delete_customer_division(
  p_division_id bigint, p_actor_user_id bigint, p_source text
)
returns public.divisions
language plpgsql
security definer
set search_path = ''
as $$
declare existing public.divisions%rowtype; reference_count bigint;
begin
  perform public.assert_it_system_admin(p_actor_user_id);
  if coalesce(length(trim(p_source)), 0) = 0 then raise exception using errcode = '22023', message = 'Audit source is required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('gwens_system_admin_invariant', 0));
  select * into existing from public.divisions where id = p_division_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'DIVISION_NOT_FOUND'; end if;
  select
    (select count(*) from public.users where division_id = p_division_id)
    + (select count(*) from public.tasks where requesting_division_id = p_division_id)
    + (select count(*) from public.tasks where owner_division_id = p_division_id)
    + (select count(*) from public.division_collaboration_rules where source_division_id = p_division_id)
    + (select count(*) from public.division_collaboration_rules where target_division_id = p_division_id)
    + (select count(*) from public.task_source_integrations where requesting_division_id = p_division_id)
    + (select count(*) from public.notification_routing_rules where owner_division_id = p_division_id)
    + (select count(*) from public.critical_alerts where owner_division_id = p_division_id)
  into reference_count;
  if reference_count <> 0 then raise exception using errcode = '23503', message = 'DIVISION_IN_USE'; end if;
  if existing.active and existing.grants_system_authority
     and (exists (select 1 from public.instance_bootstrap) or exists (select 1 from public.system_authority_assignments))
     and not exists (select 1 from public.divisions where id <> p_division_id and active and grants_system_authority) then
    raise exception using errcode = 'P0001', message = 'DIVISION_AUTHORITY_REQUIRED';
  end if;
  delete from public.divisions where id = p_division_id;
  insert into public.audit_logs (actor_type, actor_user_id, action, object_type, object_id, before_state, source)
  values ('USER', p_actor_user_id, 'DIVISION_DELETED', 'DIVISION', existing.id::text,
    jsonb_build_object('code', existing.code, 'active', existing.active), trim(p_source));
  return existing;
end;
$$;

create or replace function public.rename_reserved_role(
  p_role_id bigint, p_name text, p_actor_user_id bigint, p_source text
)
returns public.roles
language plpgsql
security definer
set search_path = ''
as $$
declare existing public.roles%rowtype; result public.roles%rowtype; normalized_name text := trim(coalesce(p_name, ''));
begin
  perform public.assert_it_system_admin(p_actor_user_id);
  if length(normalized_name) = 0 or length(normalized_name) > 120 then raise exception using errcode = '22023', message = 'INVALID_ROLE_NAME'; end if;
  if coalesce(length(trim(p_source)), 0) = 0 then raise exception using errcode = '22023', message = 'Audit source is required'; end if;
  select * into existing from public.roles where id = p_role_id and system_managed for update;
  if not found then raise exception using errcode = 'P0002', message = 'ROLE_NOT_FOUND'; end if;
  update public.roles set name = normalized_name where id = p_role_id returning * into result;
  insert into public.audit_logs (actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source)
  values ('USER', p_actor_user_id, 'ROLE_RENAMED', 'ROLE', result.id::text,
    jsonb_build_object('name', existing.name), jsonb_build_object('name', result.name), trim(p_source));
  return result;
end;
$$;

create or replace function public.create_task_category(
  p_code text, p_name text, p_actor_user_id bigint, p_source text
)
returns public.task_categories
language plpgsql
security definer
set search_path = ''
as $$
declare result public.task_categories%rowtype; normalized_code text := upper(trim(coalesce(p_code, ''))); normalized_name text := trim(coalesce(p_name, ''));
begin
  perform public.assert_it_system_admin(p_actor_user_id);
  if normalized_code !~ '^[A-Z][A-Z0-9_]{0,49}$' or length(normalized_name) = 0 or length(normalized_name) > 120 then
    raise exception using errcode = '22023', message = 'INVALID_TASK_CATEGORY';
  end if;
  if coalesce(length(trim(p_source)), 0) = 0 then raise exception using errcode = '22023', message = 'Audit source is required'; end if;
  begin
    insert into public.task_categories (code, name) values (normalized_code, normalized_name) returning * into result;
  exception when unique_violation then raise exception using errcode = '23505', message = 'TASK_CATEGORY_DUPLICATE_CODE';
  end;
  insert into public.audit_logs (actor_type, actor_user_id, action, object_type, object_id, after_state, source)
  values ('USER', p_actor_user_id, 'TASK_CATEGORY_CREATED', 'TASK_CATEGORY', result.id::text,
    jsonb_build_object('code', result.code, 'active', result.active), trim(p_source));
  return result;
end;
$$;

create or replace function public.update_task_category(
  p_category_id bigint, p_name text, p_active boolean, p_actor_user_id bigint, p_source text
)
returns public.task_categories
language plpgsql
security definer
set search_path = ''
as $$
declare existing public.task_categories%rowtype; result public.task_categories%rowtype; normalized_name text;
begin
  perform public.assert_it_system_admin(p_actor_user_id);
  if coalesce(length(trim(p_source)), 0) = 0 then raise exception using errcode = '22023', message = 'Audit source is required'; end if;
  if p_name is null and p_active is null then raise exception using errcode = '22023', message = 'INVALID_TASK_CATEGORY'; end if;
  if p_name is not null then
    normalized_name := trim(p_name);
    if length(normalized_name) = 0 or length(normalized_name) > 120 then raise exception using errcode = '22023', message = 'INVALID_TASK_CATEGORY'; end if;
  end if;
  select * into existing from public.task_categories where id = p_category_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'TASK_CATEGORY_NOT_FOUND'; end if;
  update public.task_categories set name = coalesce(normalized_name, name), active = coalesce(p_active, active)
  where id = p_category_id returning * into result;
  insert into public.audit_logs (actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source)
  values ('USER', p_actor_user_id, 'TASK_CATEGORY_UPDATED', 'TASK_CATEGORY', result.id::text,
    jsonb_build_object('name', existing.name, 'active', existing.active),
    jsonb_build_object('name', result.name, 'active', result.active), trim(p_source));
  return result;
end;
$$;

create or replace function public.delete_task_category(
  p_category_id bigint, p_actor_user_id bigint, p_source text
)
returns public.task_categories
language plpgsql
security definer
set search_path = ''
as $$
declare existing public.task_categories%rowtype;
begin
  perform public.assert_it_system_admin(p_actor_user_id);
  if coalesce(length(trim(p_source)), 0) = 0 then raise exception using errcode = '22023', message = 'Audit source is required'; end if;
  select * into existing from public.task_categories where id = p_category_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'TASK_CATEGORY_NOT_FOUND'; end if;
  if exists (select 1 from public.tasks where task_category = existing.code) then
    raise exception using errcode = '23503', message = 'TASK_CATEGORY_IN_USE';
  end if;
  delete from public.task_categories where id = p_category_id;
  insert into public.audit_logs (actor_type, actor_user_id, action, object_type, object_id, before_state, source)
  values ('USER', p_actor_user_id, 'TASK_CATEGORY_DELETED', 'TASK_CATEGORY', existing.id::text,
    jsonb_build_object('code', existing.code, 'active', existing.active), trim(p_source));
  return existing;
end;
$$;

insert into public.task_categories (code, name)
select distinct tasks.task_category, initcap(replace(tasks.task_category, '_', ' '))
from public.tasks tasks
where tasks.task_category is not null
on conflict (code) do nothing;

revoke all on function public.is_system_authority_candidate(bigint) from public, anon, authenticated;
revoke all on function public._set_division_system_authority(bigint, boolean) from public, anon, authenticated, service_role;
revoke all on function public._create_first_admin(text, text, text, text, bigint) from public, anon, authenticated, service_role;
revoke all on function public.set_division_system_authority(bigint, boolean, bigint, text) from public, anon, authenticated;
revoke all on function public.preview_first_admin_setup(text) from public, anon, authenticated;
revoke all on function public.provision_first_installation(text, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.create_customer_division(text, text, bigint, text) from public, anon, authenticated;
revoke all on function public.update_customer_division(bigint, text, boolean, bigint, text) from public, anon, authenticated;
revoke all on function public.delete_customer_division(bigint, bigint, text) from public, anon, authenticated;
revoke all on function public.rename_reserved_role(bigint, text, bigint, text) from public, anon, authenticated;
revoke all on function public.create_task_category(text, text, bigint, text) from public, anon, authenticated;
revoke all on function public.update_task_category(bigint, text, boolean, bigint, text) from public, anon, authenticated;
revoke all on function public.delete_task_category(bigint, bigint, text) from public, anon, authenticated;
grant execute on function public.set_division_system_authority(bigint, boolean, bigint, text) to service_role;
grant execute on function public.preview_first_admin_setup(text) to service_role;
grant execute on function public.provision_first_installation(text, text, text, text, text, text, text) to service_role;
grant execute on function public.create_customer_division(text, text, bigint, text) to service_role;
grant execute on function public.update_customer_division(bigint, text, boolean, bigint, text) to service_role;
grant execute on function public.delete_customer_division(bigint, bigint, text) to service_role;
grant execute on function public.rename_reserved_role(bigint, text, bigint, text) to service_role;
grant execute on function public.create_task_category(text, text, bigint, text) to service_role;
grant execute on function public.update_task_category(bigint, text, boolean, bigint, text) to service_role;
grant execute on function public.delete_task_category(bigint, bigint, text) to service_role;

comment on table public.installation_provenance is 'Append-only explicit installation lineage. Absence means UNKNOWN and is legacy-compatible.';
comment on table public.task_categories is 'Customer-managed task category validation catalog. Historical task values remain readable without a foreign key.';
comment on column public.divisions.grants_system_authority is 'TRANSITIONAL eligibility capability for SYSTEM_ADMIN assignment; owner SECURITY DEFINER writes only.';
comment on function public.assert_it_system_admin(bigint) is 'Compatibility identifier; asserts active SYSTEM_ADMIN in an authority-capable division, not a literal IT division.';
comment on function public.provision_first_installation(text, text, text, text, text, text, text) is 'Atomic explicit-lineage first installation provisioning and guarded fresh seed retirement.';

commit;
