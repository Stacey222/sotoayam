begin;

create or replace function public.is_effective_system_admin(p_user_id bigint)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.system_authority_assignments assignments
    join public.users users on users.id = assignments.user_id
    join public.divisions divisions on divisions.id = users.division_id
    where assignments.user_id = p_user_id
      and assignments.authority_code = 'SYSTEM_ADMIN'
      and assignments.revoked_at is null
      and users.active
      and divisions.active
      and divisions.grants_system_authority
  );
$$;

create or replace function public.assert_it_system_admin(p_actor_user_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_actor_user_id is null or not public.is_effective_system_admin(p_actor_user_id) then
    raise exception using errcode = '42501', message = 'Active SYSTEM_ADMIN authority in an authority-capable division is required';
  end if;
end;
$$;

create or replace function public.count_effective_system_admins()
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)
  from public.system_authority_assignments assignments
  join public.users users on users.id = assignments.user_id
  join public.divisions divisions on divisions.id = users.division_id
  where assignments.authority_code = 'SYSTEM_ADMIN'
    and assignments.revoked_at is null
    and users.active
    and divisions.active
    and divisions.grants_system_authority;
$$;

create or replace function public.protect_final_system_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  effective_others bigint;
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

  if old.authority_code = 'SYSTEM_ADMIN' and old.revoked_at is null
     and removes_active_assignment and public.is_effective_system_admin(old.user_id) then
    perform pg_advisory_xact_lock(hashtextextended('gwens_system_admin_invariant', 0));
    select count(*) into effective_others
    from public.system_authority_assignments assignments
    join public.users users on users.id = assignments.user_id
    join public.divisions divisions on divisions.id = users.division_id
    where assignments.authority_code = 'SYSTEM_ADMIN'
      and assignments.revoked_at is null
      and assignments.id <> old.id
      and users.active
      and divisions.active
      and divisions.grants_system_authority;
    if effective_others = 0 then
      raise exception using errcode = 'P0001', message = 'LAST_SYSTEM_ADMIN';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
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
  new_division_capable boolean := false;
  new_effective boolean := false;
  effective_others bigint;
begin
  select divisions.active and divisions.grants_system_authority into new_division_capable
  from public.divisions divisions where divisions.id = new.division_id;
  new_effective := new.active and coalesce(new_division_capable, false) and exists (
    select 1 from public.system_authority_assignments assignments
    where assignments.user_id = old.id
      and assignments.authority_code = 'SYSTEM_ADMIN'
      and assignments.revoked_at is null
  );

  if public.is_effective_system_admin(old.id) and not new_effective then
    perform pg_advisory_xact_lock(hashtextextended('gwens_system_admin_invariant', 0));
    select count(*) into effective_others
    from public.system_authority_assignments assignments
    join public.users users on users.id = assignments.user_id
    join public.divisions divisions on divisions.id = users.division_id
    where assignments.authority_code = 'SYSTEM_ADMIN'
      and assignments.revoked_at is null
      and users.id <> old.id
      and users.active
      and divisions.active
      and divisions.grants_system_authority;
    if effective_others = 0 then
      raise exception using errcode = 'P0001', message = 'LAST_SYSTEM_ADMIN';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.protect_last_authority_capability_division()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  removes_capability boolean := false;
  affected_effective_admins bigint := 0;
  effective_others bigint := 0;
begin
  if tg_op = 'DELETE' then
    removes_capability := old.active and old.grants_system_authority;
  else
    removes_capability := old.active and old.grants_system_authority
      and (not new.active or not new.grants_system_authority);
  end if;

  if removes_capability then
    perform pg_advisory_xact_lock(hashtextextended('gwens_system_admin_invariant', 0));
    select count(*) into affected_effective_admins
    from public.system_authority_assignments assignments
    join public.users users on users.id = assignments.user_id
    where assignments.authority_code = 'SYSTEM_ADMIN'
      and assignments.revoked_at is null
      and users.active
      and users.division_id = old.id;
    select count(*) into effective_others
    from public.system_authority_assignments assignments
    join public.users users on users.id = assignments.user_id
    join public.divisions divisions on divisions.id = users.division_id
    where assignments.authority_code = 'SYSTEM_ADMIN'
      and assignments.revoked_at is null
      and users.active
      and users.division_id <> old.id
      and divisions.active
      and divisions.grants_system_authority;
    if affected_effective_admins > 0 and effective_others = 0 then
      raise exception using errcode = 'P0001', message = 'LAST_SYSTEM_ADMIN';
    end if;
    if (exists (select 1 from public.instance_bootstrap)
        or exists (select 1 from public.system_authority_assignments))
       and not exists (
         select 1 from public.divisions divisions
         where divisions.id <> old.id and divisions.active and divisions.grants_system_authority
       ) then
      raise exception using errcode = 'P0001', message = 'DIVISION_AUTHORITY_REQUIRED';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
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
  perform public.assert_it_system_admin(p_actor_user_id);
  if not public.is_system_authority_candidate(p_user_id) then
    raise exception using errcode = 'P0001', message = 'SYSTEM_ADMIN candidate must be active in an authority-capable division';
  end if;
  select * into assignment from public.system_authority_assignments
  where user_id = p_user_id and authority_code = 'SYSTEM_ADMIN' and revoked_at is null;
  if found then return next assignment; return; end if;

  insert into public.system_authority_assignments (user_id, authority_code, granted_by_user_id, reason)
  values (p_user_id, 'SYSTEM_ADMIN', p_actor_user_id, trim(p_reason)) returning * into assignment;
  insert into public.audit_logs (actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source)
  values ('USER', p_actor_user_id, 'SYSTEM_ADMIN_GRANTED', 'SYSTEM_AUTHORITY_ASSIGNMENT', assignment.id::text, null,
    jsonb_build_object('user_id', p_user_id, 'authority_code', 'SYSTEM_ADMIN', 'reason', trim(p_reason)),
    'admin_session_api');
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
  perform public.assert_it_system_admin(p_actor_user_id);
  select * into assignment from public.system_authority_assignments
  where user_id = p_user_id and authority_code = 'SYSTEM_ADMIN' and revoked_at is null for update;
  if not found then raise exception using errcode = 'P0002', message = 'Active SYSTEM_ADMIN assignment not found'; end if;

  update public.system_authority_assignments set
    revoked_at = now(), revoked_by_user_id = p_actor_user_id, revocation_reason = trim(p_reason)
  where id = assignment.id returning * into assignment;
  insert into public.audit_logs (actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source)
  values ('USER', p_actor_user_id, 'SYSTEM_ADMIN_REVOKED', 'SYSTEM_AUTHORITY_ASSIGNMENT', assignment.id::text,
    jsonb_build_object('user_id', p_user_id, 'authority_code', 'SYSTEM_ADMIN'),
    jsonb_build_object('revoked', true), 'admin_session_api');
  return next assignment;
  return;
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
  if coalesce(length(trim(p_source)), 0) = 0 then raise exception using errcode = '22023', message = 'Audit source is required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('gwens_system_admin_invariant', 0));
  perform public.assert_it_system_admin(p_actor_user_id);
  select * into existing from public.divisions where id = p_division_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Division not found'; end if;
  if existing.grants_system_authority = p_enabled then return existing; end if;
  result := public._set_division_system_authority(p_division_id, p_enabled);
  insert into public.audit_logs (actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source)
  values ('USER', p_actor_user_id, 'DIVISION_AUTHORITY_CAPABILITY_CHANGED', 'DIVISION', p_division_id::text,
    jsonb_build_object('grants_system_authority', existing.grants_system_authority),
    jsonb_build_object('grants_system_authority', result.grants_system_authority), trim(p_source));
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
  if p_name is null and p_active is null then raise exception using errcode = '22023', message = 'INVALID_DIVISION'; end if;
  if p_name is not null then
    normalized_name := trim(p_name);
    if length(normalized_name) = 0 or length(normalized_name) > 120 then raise exception using errcode = '22023', message = 'INVALID_DIVISION'; end if;
  end if;
  if coalesce(length(trim(p_source)), 0) = 0 then raise exception using errcode = '22023', message = 'Audit source is required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('gwens_system_admin_invariant', 0));
  perform public.assert_it_system_admin(p_actor_user_id);
  select * into existing from public.divisions where id = p_division_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'DIVISION_NOT_FOUND'; end if;
  update public.divisions set name = coalesce(normalized_name, name), active = coalesce(p_active, active)
  where id = p_division_id returning * into result;
  insert into public.audit_logs (actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source)
  values ('USER', p_actor_user_id, 'DIVISION_UPDATED', 'DIVISION', result.id::text,
    jsonb_build_object('name', existing.name, 'active', existing.active),
    jsonb_build_object('name', result.name, 'active', result.active), trim(p_source));
  return result;
end;
$$;

revoke all on function public.is_effective_system_admin(bigint) from public, anon, authenticated, service_role;
revoke all on function public.count_effective_system_admins() from public, anon, authenticated;
revoke all on function public.assign_system_admin(bigint, text, bigint) from public, anon, authenticated;
revoke all on function public.revoke_system_admin(bigint, text, bigint) from public, anon, authenticated;
revoke all on function public.set_division_system_authority(bigint, boolean, bigint, text) from public, anon, authenticated;
revoke all on function public.update_customer_division(bigint, text, boolean, bigint, text) from public, anon, authenticated;
grant execute on function public.assign_system_admin(bigint, text, bigint) to service_role;
grant execute on function public.count_effective_system_admins() to service_role;
grant execute on function public.revoke_system_admin(bigint, text, bigint) to service_role;
grant execute on function public.set_division_system_authority(bigint, boolean, bigint, text) to service_role;
grant execute on function public.update_customer_division(bigint, text, boolean, bigint, text) to service_role;

comment on function public.is_effective_system_admin(bigint) is
  'Internal invariant predicate: unrevoked SYSTEM_ADMIN on an active user in an active authority-capable division.';
comment on function public.assign_system_admin(bigint, text, bigint) is
  'Session-actor-attributed SYSTEM_ADMIN grant serialized by the compatibility advisory lock.';
comment on function public.revoke_system_admin(bigint, text, bigint) is
  'Session-actor-attributed SYSTEM_ADMIN revocation preserving at least one effective administrator.';

commit;
