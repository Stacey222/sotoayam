begin;

alter table public.system_authority_assignments
  add column if not exists revocation_reason text
  check (revocation_reason is null or (length(trim(revocation_reason)) > 0 and length(revocation_reason) <= 500));

create or replace function public.legacy_division_value(p_code text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select case p_code
    when 'PURCHASING' then 'Purchasing'
    when 'SALES_GROSIR' then 'Sales Grosir'
    when 'DIGITAL_MARKETING' then 'Digital Marketing'
    when 'CONTENT_CREATOR' then 'Content Creator'
    when 'ONPAGE_B2C' then 'On Page / B2C'
    when 'SHOPEE_LIVE' then 'Live Shopee'
    when 'GUDANG' then 'Gudang'
    when 'MANAGEMENT' then 'Management'
    when 'IT' then 'IT'
  end;
$$;

create or replace function public.legacy_role_value(p_code text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select case p_code
    when 'STAFF' then 'Staff'
    when 'ADMIN' then 'Admin'
    when 'OWNER' then 'Owner'
  end;
$$;

create or replace function public.protect_final_system_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  active_others bigint;
  removes_active_assignment boolean := false;
begin
  if tg_op = 'UPDATE' then
    if new.user_id is distinct from old.user_id
      or new.authority_code is distinct from old.authority_code
      or new.granted_at is distinct from old.granted_at
      or new.granted_by_user_id is distinct from old.granted_by_user_id then
      raise exception using errcode = 'P0001', message = 'SYSTEM_ADMIN assignment identity and grant metadata are immutable';
    end if;
    removes_active_assignment := new.revoked_at is not null;
  elsif tg_op = 'DELETE' then
    removes_active_assignment := true;
  end if;
  if old.authority_code = 'SYSTEM_ADMIN' and old.revoked_at is null and removes_active_assignment then
    perform pg_advisory_xact_lock(hashtextextended('gwens_system_admin_invariant', 0));
    select count(*) into active_others
    from public.system_authority_assignments assignments
    where assignments.authority_code = 'SYSTEM_ADMIN'
      and assignments.revoked_at is null
      and assignments.id <> old.id;
    if active_others = 0 then
      raise exception using
        errcode = 'P0001',
        message = 'Final active SYSTEM_ADMIN cannot be revoked without a replacement';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function public.validate_system_admin_candidate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.authority_code = 'SYSTEM_ADMIN' and new.revoked_at is null and not exists (
    select 1 from public.users users
    join public.divisions divisions on divisions.id = users.division_id
    where users.id = new.user_id and users.active and divisions.code = 'IT'
  ) then
    raise exception using errcode = 'P0001', message = 'SYSTEM_ADMIN candidate must be an active IT user';
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
  target_division_code text;
  active_authority_count bigint;
begin
  select code into target_division_code from public.divisions where id = new.division_id;
  if exists (
    select 1 from public.system_authority_assignments assignments
    where assignments.user_id = old.id and assignments.authority_code = 'SYSTEM_ADMIN' and assignments.revoked_at is null
  ) and (not new.active or target_division_code is distinct from 'IT') then
    perform pg_advisory_xact_lock(hashtextextended('gwens_system_admin_invariant', 0));
    select count(*) into active_authority_count from public.system_authority_assignments assignments
    where assignments.authority_code = 'SYSTEM_ADMIN' and assignments.revoked_at is null;
    if active_authority_count <= 1 then
      raise exception using errcode = 'P0001', message = 'Final active SYSTEM_ADMIN must remain active in IT until handover';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_final_system_admin_assignment on public.system_authority_assignments;
create trigger protect_final_system_admin_assignment
before update or delete on public.system_authority_assignments
for each row execute function public.protect_final_system_admin();

drop trigger if exists validate_system_admin_candidate_assignment on public.system_authority_assignments;
create trigger validate_system_admin_candidate_assignment
before insert or update on public.system_authority_assignments
for each row execute function public.validate_system_admin_candidate();

drop trigger if exists protect_final_system_admin_user_access on public.users;
create trigger protect_final_system_admin_user_access
before update of active, division_id on public.users
for each row execute function public.protect_final_system_admin_user();

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
  active_authority_count bigint;
begin
  if p_source is null or length(trim(p_source)) = 0 then
    raise exception using errcode = '22023', message = 'Audit source is required';
  end if;

  select * into existing_user from public.users where id = p_user_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Normalized user not found'; end if;
  if existing_user.legacy_telegram_user_id is null then
    raise exception using errcode = 'P0001', message = 'Legacy compatibility mapping is required';
  end if;

  if p_division_id is not null then
    select * into division_row from public.divisions where id = p_division_id;
    if not found then raise exception using errcode = '23503', message = 'Division not found'; end if;
    if p_division_id is distinct from existing_user.division_id and not division_row.active then
      raise exception using errcode = 'P0001', message = 'Disabled division cannot be newly assigned';
    end if;
    target_division_code := division_row.code;
    if public.legacy_division_value(target_division_code) is null then
      raise exception using errcode = 'P0001', message = 'Division has no legacy compatibility mapping';
    end if;
  end if;

  if p_role_id is not null then
    select * into role_row from public.roles where id = p_role_id;
    if not found then raise exception using errcode = '23503', message = 'Role not found'; end if;
    if p_role_id is distinct from existing_user.role_id and not role_row.active then
      raise exception using errcode = 'P0001', message = 'Disabled role cannot be newly assigned';
    end if;
    target_role_code := role_row.code;
    if public.legacy_role_value(target_role_code) is null then
      raise exception using errcode = 'P0001', message = 'Role has no legacy compatibility mapping';
    end if;
  end if;

  if p_active and (p_division_id is null or p_role_id is null) then
    raise exception using errcode = '23514', message = 'Active user requires a division and role';
  end if;

  select code into current_division_code from public.divisions where id = existing_user.division_id;
  select code into current_role_code from public.roles where id = existing_user.role_id;

  if exists (
    select 1 from public.system_authority_assignments assignments
    where assignments.user_id = p_user_id
      and assignments.authority_code = 'SYSTEM_ADMIN'
      and assignments.revoked_at is null
  ) and (not p_active or target_division_code is distinct from 'IT') then
    perform pg_advisory_xact_lock(hashtextextended('gwens_system_admin_invariant', 0));
    select count(*) into active_authority_count
    from public.system_authority_assignments assignments
    where assignments.authority_code = 'SYSTEM_ADMIN' and assignments.revoked_at is null;
    if active_authority_count <= 1 then
      raise exception using errcode = 'P0001', message = 'Final active SYSTEM_ADMIN must remain active in IT until handover';
    end if;
  end if;

  update public.users set
    division_id = p_division_id,
    role_id = p_role_id,
    active = p_active
  where id = p_user_id
  returning * into updated_user;

  update public.telegram_users set
    division = coalesce(public.legacy_division_value(target_division_code), 'UNASSIGNED'),
    role = coalesce(public.legacy_role_value(target_role_code), 'UNASSIGNED'),
    active = p_active
  where id = existing_user.legacy_telegram_user_id;
  if not found then raise exception using errcode = 'P0002', message = 'Legacy user not found'; end if;

  if existing_user.division_id is distinct from p_division_id then
    insert into public.audit_logs (actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source)
    values (case when p_actor_user_id is null then 'SYSTEM' else 'USER' end, p_actor_user_id,
      'USER_DIVISION_CHANGED', 'USER', p_user_id::text,
      jsonb_build_object('division_code', current_division_code),
      jsonb_build_object('division_code', target_division_code), trim(p_source));
  end if;
  if existing_user.role_id is distinct from p_role_id then
    insert into public.audit_logs (actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source)
    values (case when p_actor_user_id is null then 'SYSTEM' else 'USER' end, p_actor_user_id,
      'USER_ROLE_CHANGED', 'USER', p_user_id::text,
      jsonb_build_object('role_code', current_role_code),
      jsonb_build_object('role_code', target_role_code), trim(p_source));
  end if;
  if existing_user.active is distinct from p_active then
    insert into public.audit_logs (actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source)
    values (case when p_actor_user_id is null then 'SYSTEM' else 'USER' end, p_actor_user_id,
      case when p_active then 'USER_ACTIVATED' else 'USER_DEACTIVATED' end,
      'USER', p_user_id::text,
      jsonb_build_object('active', existing_user.active),
      jsonb_build_object('active', p_active), trim(p_source));
  end if;

  return next updated_user;
  return;
end;
$$;

create or replace function public.assign_system_admin(
  p_user_id bigint,
  p_reason text,
  p_actor_user_id bigint default null
)
returns setof public.system_authority_assignments
language plpgsql
security definer
set search_path = ''
as $$
declare
  assignment public.system_authority_assignments%rowtype;
begin
  if p_reason is null or length(trim(p_reason)) = 0 or length(p_reason) > 500 then
    raise exception using errcode = '22023', message = 'Reason must contain 1-500 characters';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('gwens_system_admin_invariant', 0));
  if not exists (
    select 1 from public.users users
    join public.divisions divisions on divisions.id = users.division_id
    where users.id = p_user_id and users.active and divisions.code = 'IT'
  ) then
    raise exception using errcode = 'P0001', message = 'SYSTEM_ADMIN candidate must be an active IT user';
  end if;
  select * into assignment from public.system_authority_assignments
  where user_id = p_user_id and authority_code = 'SYSTEM_ADMIN' and revoked_at is null;
  if found then return next assignment; return; end if;

  insert into public.system_authority_assignments (user_id, authority_code, granted_by_user_id, reason)
  values (p_user_id, 'SYSTEM_ADMIN', p_actor_user_id, trim(p_reason)) returning * into assignment;
  insert into public.audit_logs (actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source)
  values (case when p_actor_user_id is null then 'SYSTEM' else 'USER' end, p_actor_user_id,
    'SYSTEM_ADMIN_GRANTED', 'SYSTEM_AUTHORITY_ASSIGNMENT', assignment.id::text, null,
    jsonb_build_object('user_id', p_user_id, 'authority_code', 'SYSTEM_ADMIN', 'reason', trim(p_reason)),
    'admin_api_shared_key');
  return next assignment;
  return;
end;
$$;

create or replace function public.revoke_system_admin(
  p_user_id bigint,
  p_reason text,
  p_actor_user_id bigint default null
)
returns setof public.system_authority_assignments
language plpgsql
security definer
set search_path = ''
as $$
declare
  assignment public.system_authority_assignments%rowtype;
begin
  if p_reason is null or length(trim(p_reason)) = 0 or length(p_reason) > 500 then
    raise exception using errcode = '22023', message = 'Reason must contain 1-500 characters';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('gwens_system_admin_invariant', 0));
  select * into assignment from public.system_authority_assignments
  where user_id = p_user_id and authority_code = 'SYSTEM_ADMIN' and revoked_at is null for update;
  if not found then raise exception using errcode = 'P0002', message = 'Active SYSTEM_ADMIN assignment not found'; end if;

  update public.system_authority_assignments set
    revoked_at = now(), revoked_by_user_id = p_actor_user_id,
    revocation_reason = trim(p_reason)
  where id = assignment.id returning * into assignment;
  insert into public.audit_logs (actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source)
  values (case when p_actor_user_id is null then 'SYSTEM' else 'USER' end, p_actor_user_id,
    'SYSTEM_ADMIN_REVOKED', 'SYSTEM_AUTHORITY_ASSIGNMENT', assignment.id::text,
    jsonb_build_object('user_id', p_user_id, 'authority_code', 'SYSTEM_ADMIN'),
    jsonb_build_object('revoked', true), 'admin_api_shared_key');
  return next assignment;
  return;
end;
$$;

revoke all on function public.legacy_division_value(text) from public, anon, authenticated;
revoke all on function public.legacy_role_value(text) from public, anon, authenticated;
revoke all on function public.update_user_access(bigint, bigint, bigint, boolean, bigint, text) from public, anon, authenticated;
revoke all on function public.assign_system_admin(bigint, text, bigint) from public, anon, authenticated;
revoke all on function public.revoke_system_admin(bigint, text, bigint) from public, anon, authenticated;
grant execute on function public.update_user_access(bigint, bigint, bigint, boolean, bigint, text) to service_role;
grant execute on function public.assign_system_admin(bigint, text, bigint) to service_role;
grant execute on function public.revoke_system_admin(bigint, text, bigint) to service_role;

comment on function public.update_user_access(bigint, bigint, bigint, boolean, bigint, text) is
  'Service-only transactional authority write for normalized access, legacy compatibility, and sanitized audit.';
comment on function public.assign_system_admin(bigint, text, bigint) is
  'Explicit service-only SYSTEM_ADMIN bootstrap or handover grant; never called automatically.';
comment on function public.revoke_system_admin(bigint, text, bigint) is
  'Explicit service-only SYSTEM_ADMIN revocation protected by the nonzero invariant after bootstrap.';

commit;
