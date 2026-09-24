begin;

create function public.provision_first_owner(
  p_display_name text,
  p_email text,
  p_password_algorithm text,
  p_password_hash text,
  p_division_code text,
  p_division_name text,
  p_business_time_zone text,
  p_reminder_scheduler_interval_seconds integer,
  p_critical_alert_policy jsonb
)
returns table (
  user_id bigint,
  assignment_id bigint,
  bootstrapped_at timestamptz,
  division_code text,
  settings_version bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  provisioned record;
  owner_role_id bigint;
  owner_division_id bigint;
  runtime_settings record;
  final_settings record;
begin
  -- Reuse the compatibility lock name and ordering used by the existing
  -- SYSTEM_ADMIN and business-actor invariants. PostgreSQL advisory locks are
  -- transaction-scoped, so every bootstrap effect commits or rolls back together.
  perform pg_advisory_xact_lock(hashtextextended('gwens_system_admin_invariant', 0));
  perform pg_advisory_xact_lock(hashtextextended('sotoayam_business_actor_invariant', 0));

  select * into provisioned
  from public.provision_first_installation(
    p_display_name,
    p_email,
    p_password_algorithm,
    p_password_hash,
    'FRESH',
    p_division_code,
    p_division_name
  );

  select roles.id into owner_role_id
  from public.roles roles
  where roles.code = 'OWNER' and roles.active;
  if owner_role_id is null then
    raise exception using errcode = 'P0002', message = 'OWNER_ROLE_UNAVAILABLE';
  end if;

  select users.division_id into owner_division_id
  from public.users users
  where users.id = provisioned.user_id;

  perform public.update_managed_user_access(
    provisioned.user_id,
    owner_division_id,
    owner_role_id,
    true,
    provisioned.user_id,
    'first_owner_bootstrap',
    false,
    'Initial customer OWNER assignment'
  );

  select * into runtime_settings
  from public.update_instance_runtime_settings(
    provisioned.user_id,
    0,
    p_business_time_zone,
    p_reminder_scheduler_interval_seconds,
    p_critical_alert_policy,
    'Initial customer runtime settings'
  );

  select * into final_settings
  from public.set_instance_business_actor(
    provisioned.user_id,
    runtime_settings.version,
    provisioned.user_id,
    'Initial customer business actor'
  );

  insert into public.audit_logs (
    actor_type, actor_user_id, action, object_type, object_id, after_state, source
  ) values (
    'USER', provisioned.user_id, 'FIRST_OWNER_BOOTSTRAPPED', 'USER', provisioned.user_id::text,
    jsonb_build_object(
      'role_code', 'OWNER',
      'authority_code', 'SYSTEM_ADMIN',
      'business_actor_assigned', true,
      'password_change_required', false
    ),
    'first_owner_bootstrap'
  );

  return query select
    provisioned.user_id,
    provisioned.assignment_id,
    provisioned.bootstrapped_at,
    provisioned.division_code,
    final_settings.version;
end;
$$;

revoke all on function public.provision_first_owner(text, text, text, text, text, text, text, integer, jsonb)
  from public, anon, authenticated;
grant execute on function public.provision_first_owner(text, text, text, text, text, text, text, integer, jsonb)
  to service_role;

comment on function public.provision_first_owner(text, text, text, text, text, text, text, integer, jsonb) is
  'Atomically provisions the one-time fresh-install OWNER, explicit SYSTEM_ADMIN authority, runtime settings, and business actor.';

commit;
