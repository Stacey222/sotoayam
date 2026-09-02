begin;

alter table public.users
  add column business_user_code text,
  add constraint users_business_user_code_format_check check (
    business_user_code is null
    or (
      length(business_user_code) between 3 and 40
      and business_user_code = upper(trim(business_user_code))
      and business_user_code ~ '^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*$'
    )
  );

create unique index users_business_user_code_uidx
  on public.users (business_user_code)
  where business_user_code is not null;

create table public.integration_capabilities (
  id bigint generated always as identity primary key,
  integration_id bigint not null references public.task_source_integrations (id),
  capability_code text not null check (capability_code = 'TASK_CREATE'),
  granted_by_user_id bigint not null references public.users (id),
  granted_at timestamptz not null default now(),
  revoked_by_user_id bigint references public.users (id),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (integration_id, capability_code),
  check ((revoked_at is null and revoked_by_user_id is null) or (revoked_at is not null and revoked_by_user_id is not null))
);

create index integration_capabilities_active_idx
  on public.integration_capabilities (integration_id, capability_code)
  where revoked_at is null;

create trigger set_integration_capabilities_updated_at
before update on public.integration_capabilities
for each row execute function public.set_governance_updated_at();

alter table public.integration_capabilities enable row level security;

create or replace function public.assert_it_system_admin(p_actor_user_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.users users
    join public.divisions divisions on divisions.id = users.division_id
    join public.system_authority_assignments authority on authority.user_id = users.id
    where users.id = p_actor_user_id
      and users.active
      and divisions.code = 'IT'
      and authority.authority_code = 'SYSTEM_ADMIN'
      and authority.revoked_at is null
  ) then
    raise exception using errcode = '42501', message = 'Active IT SYSTEM_ADMIN authority is required';
  end if;
end;
$$;

create or replace function public.update_business_user_code(
  p_user_id bigint,
  p_business_user_code text,
  p_confirm_change boolean,
  p_actor_user_id bigint,
  p_source text
)
returns setof public.users
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_user public.users%rowtype;
  updated_user public.users%rowtype;
  normalized_code text;
begin
  perform public.assert_it_system_admin(p_actor_user_id);
  if p_source is null or length(trim(p_source)) = 0 then
    raise exception using errcode = '22023', message = 'Audit source is required';
  end if;
  normalized_code := case when p_business_user_code is null then null else upper(trim(p_business_user_code)) end;
  select * into existing_user from public.users where id = p_user_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Normalized user not found'; end if;
  if existing_user.business_user_code is not null
    and existing_user.business_user_code is distinct from normalized_code
    and not p_confirm_change then
    raise exception using errcode = 'P0001', message = 'Changing an existing business user code requires explicit confirmation';
  end if;
  if existing_user.business_user_code is not distinct from normalized_code then
    return next existing_user;
    return;
  end if;
  update public.users set business_user_code = normalized_code where id = p_user_id returning * into updated_user;
  insert into public.audit_logs (
    actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source
  ) values (
    'USER', p_actor_user_id,
    case when existing_user.business_user_code is null then 'BUSINESS_USER_CODE_ASSIGNED' else 'BUSINESS_USER_CODE_CHANGED' end,
    'USER_BUSINESS_IDENTITY', p_user_id::text,
    jsonb_build_object('business_user_code', existing_user.business_user_code),
    jsonb_build_object('business_user_code', updated_user.business_user_code),
    trim(p_source)
  );
  return next updated_user;
end;
$$;

create or replace function public.create_task_source_integration(
  p_code text,
  p_name text,
  p_source text,
  p_requesting_division_id bigint,
  p_actor_user_id bigint
)
returns setof public.task_source_integrations
language plpgsql
security definer
set search_path = ''
as $$
declare created public.task_source_integrations%rowtype;
begin
  perform public.assert_it_system_admin(p_actor_user_id);
  insert into public.task_source_integrations (code, name, source, requesting_division_id, active)
  values (upper(trim(p_code)), trim(p_name), upper(trim(p_source)), p_requesting_division_id, false)
  returning * into created;
  insert into public.audit_logs (actor_type, actor_user_id, action, object_type, object_id, after_state, source)
  values ('USER', p_actor_user_id, 'INTEGRATION_IDENTITY_CREATED', 'TASK_SOURCE_INTEGRATION', created.id::text,
    jsonb_build_object('code', created.code, 'source', created.source, 'requesting_division_id', created.requesting_division_id, 'active', false),
    'integration_admin_api');
  return next created;
end;
$$;

create or replace function public.set_task_source_integration_active(
  p_integration_id bigint,
  p_active boolean,
  p_actor_user_id bigint
)
returns setof public.task_source_integrations
language plpgsql
security definer
set search_path = ''
as $$
declare existing public.task_source_integrations%rowtype; updated public.task_source_integrations%rowtype;
begin
  perform public.assert_it_system_admin(p_actor_user_id);
  select * into existing from public.task_source_integrations where id = p_integration_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Integration identity not found'; end if;
  if existing.active = p_active then return next existing; return; end if;
  update public.task_source_integrations set active = p_active where id = p_integration_id returning * into updated;
  insert into public.audit_logs (actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source)
  values ('USER', p_actor_user_id, case when p_active then 'INTEGRATION_ACTIVATED' else 'INTEGRATION_DEACTIVATED' end,
    'TASK_SOURCE_INTEGRATION', p_integration_id::text, jsonb_build_object('active', existing.active),
    jsonb_build_object('active', updated.active), 'integration_admin_api');
  return next updated;
end;
$$;

create or replace function public.grant_integration_capability(
  p_integration_id bigint,
  p_capability_code text,
  p_actor_user_id bigint
)
returns setof public.integration_capabilities
language plpgsql
security definer
set search_path = ''
as $$
declare existing public.integration_capabilities%rowtype; granted public.integration_capabilities%rowtype; normalized_code text;
begin
  perform public.assert_it_system_admin(p_actor_user_id);
  normalized_code := upper(trim(p_capability_code));
  perform pg_advisory_xact_lock(hashtextextended('gwens_integration_capability:' || p_integration_id::text || ':' || normalized_code, 0));
  select * into existing from public.integration_capabilities
    where integration_id = p_integration_id and capability_code = normalized_code for update;
  if found and existing.revoked_at is null then return next existing; return; end if;
  if found then
    update public.integration_capabilities set granted_by_user_id = p_actor_user_id, granted_at = now(),
      revoked_by_user_id = null, revoked_at = null
    where id = existing.id returning * into granted;
  else
    insert into public.integration_capabilities (integration_id, capability_code, granted_by_user_id)
    values (p_integration_id, normalized_code, p_actor_user_id) returning * into granted;
  end if;
  insert into public.audit_logs (actor_type, actor_user_id, action, object_type, object_id, after_state, source)
  values ('USER', p_actor_user_id, 'INTEGRATION_CAPABILITY_GRANTED', 'INTEGRATION_CAPABILITY', granted.id::text,
    jsonb_build_object('integration_id', granted.integration_id, 'capability_code', granted.capability_code, 'active', true),
    'integration_admin_api');
  return next granted;
end;
$$;

create or replace function public.revoke_integration_capability(
  p_integration_id bigint,
  p_capability_code text,
  p_actor_user_id bigint
)
returns setof public.integration_capabilities
language plpgsql
security definer
set search_path = ''
as $$
declare existing public.integration_capabilities%rowtype; revoked public.integration_capabilities%rowtype; normalized_code text;
begin
  perform public.assert_it_system_admin(p_actor_user_id);
  normalized_code := upper(trim(p_capability_code));
  select * into existing from public.integration_capabilities
    where integration_id = p_integration_id and capability_code = normalized_code for update;
  if not found or existing.revoked_at is not null then
    raise exception using errcode = 'P0002', message = 'Active integration capability not found';
  end if;
  update public.integration_capabilities set revoked_by_user_id = p_actor_user_id, revoked_at = now()
  where id = existing.id returning * into revoked;
  insert into public.audit_logs (actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source)
  values ('USER', p_actor_user_id, 'INTEGRATION_CAPABILITY_REVOKED', 'INTEGRATION_CAPABILITY', revoked.id::text,
    jsonb_build_object('integration_id', revoked.integration_id, 'capability_code', revoked.capability_code, 'active', true),
    jsonb_build_object('integration_id', revoked.integration_id, 'capability_code', revoked.capability_code, 'active', false),
    'integration_admin_api');
  return next revoked;
end;
$$;

revoke all on function public.assert_it_system_admin(bigint) from public, anon, authenticated;
revoke all on function public.update_business_user_code(bigint, text, boolean, bigint, text) from public, anon, authenticated;
revoke all on function public.create_task_source_integration(text, text, text, bigint, bigint) from public, anon, authenticated;
revoke all on function public.set_task_source_integration_active(bigint, boolean, bigint) from public, anon, authenticated;
revoke all on function public.grant_integration_capability(bigint, text, bigint) from public, anon, authenticated;
revoke all on function public.revoke_integration_capability(bigint, text, bigint) from public, anon, authenticated;
grant execute on function public.update_business_user_code(bigint, text, boolean, bigint, text) to service_role;
grant execute on function public.create_task_source_integration(text, text, text, bigint, bigint) to service_role;
grant execute on function public.set_task_source_integration_active(bigint, boolean, bigint) to service_role;
grant execute on function public.grant_integration_capability(bigint, text, bigint) to service_role;
grant execute on function public.revoke_integration_capability(bigint, text, bigint) to service_role;

comment on column public.users.business_user_code is 'Stable business-facing human identifier. It is never derived from Telegram or internal database identity.';
comment on table public.integration_capabilities is 'Explicit default-deny machine integration capabilities. No human authority is represented here.';

commit;
