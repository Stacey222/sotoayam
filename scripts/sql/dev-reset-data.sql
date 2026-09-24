begin;

-- Development-only reset. The CLI verifies the direct database/project identity
-- and requires an operator confirmation before this file can reach psql.
lock table public.users, public.admin_credentials, public.system_authority_assignments,
  public.instance_bootstrap, public.instance_settings in access exclusive mode;

do $$
declare
  kento_id bigint;
  owner_id bigint;
  bootstrap_id bigint;
  required_grants integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('gwens_system_admin_invariant', 0));
  perform pg_advisory_xact_lock(hashtextextended('sotoayam_business_actor_invariant', 0));
  select c.user_id into kento_id from public.admin_credentials c
    where c.email = 'owner@sotoayam.local';
  if kento_id is null or (select count(*) from public.admin_credentials
      where email = 'owner@sotoayam.local') <> 1 then
    raise exception 'RESET_KENTO_CREDENTIAL_REQUIRED';
  end if;
  if not exists (select 1 from public.users u join public.divisions d on d.id = u.division_id
      where u.id = kento_id and u.display_name = 'Kento' and u.active
        and d.active and d.grants_system_authority) then
    raise exception 'RESET_KENTO_AUTHORITY_DIVISION_REQUIRED';
  end if;
  if not exists (select 1 from public.admin_credentials c where c.user_id = kento_id
      and not c.password_change_required) or not public.is_effective_system_admin(kento_id) then
    raise exception 'RESET_KENTO_LOGIN_AND_AUTHORITY_REQUIRED';
  end if;
  select first_admin_user_id into bootstrap_id from public.instance_bootstrap;
  if bootstrap_id is distinct from kento_id then
    raise exception 'RESET_BOOTSTRAP_REFERENCES_OTHER_USER';
  end if;
  select id into owner_id from public.roles where code = 'OWNER' and active;
  select count(distinct p.code) into required_grants from public.role_permissions rp
    join public.permissions p on p.id = rp.permission_id and p.active
    where rp.role_id = owner_id and p.code = any(array[
      'task.view_assigned','task.create','task.update_assigned','task.complete_assigned',
      'task.add_activity','task.view_division','report.view_cross_division',
      'alert.view_critical','alert.acknowledge','approval.view','approval.decide',
      'automation_status.view_business','threshold.manage']);
  if owner_id is null or required_grants <> 13 then
    raise exception 'RESET_OWNER_MVP_GRANTS_REQUIRED';
  end if;
end $$;

-- Operational data and old audit records are a single disposable development
-- dataset. TRUNCATE intentionally bypasses the append-only row trigger; no
-- production command uses this SQL. New role/designation/reset audit follows.
truncate table
  public.task_relationships, public.task_activities, public.notification_deliveries,
  public.notifications, public.notification_events, public.task_reminder_states,
  public.task_import_batches, public.tasks, public.critical_alerts,
  public.user_channels, public.notification_routing_rules,
  public.integration_credentials, public.integration_capabilities,
  public.task_source_integrations, public.admin_sessions, public.admin_login_attempts,
  public.telegram_notification_preferences, public.telegram_processed_updates,
  public.telegram_polling_state, public.critical_alert_evaluator_state,
  public.reminder_scheduler_state, public.audit_logs;

do $$
declare
  kento_id bigint;
  owner_id bigint;
  division_id bigint;
  current_role_id bigint;
  settings_version bigint;
  designated_id bigint;
begin
  select c.user_id into kento_id from public.admin_credentials c
    where c.email = 'owner@sotoayam.local';
  select id into owner_id from public.roles where code = 'OWNER' and active;
  select u.division_id, u.role_id into division_id, current_role_id
    from public.users u where u.id = kento_id;
  if current_role_id <> owner_id then
    perform public.update_managed_user_access(kento_id, division_id, owner_id,
      true, kento_id, 'dev_data_reset', false, 'Development identity reset');
  end if;
  select version, business_actor_user_id into settings_version, designated_id
    from public.instance_settings where singleton_key for update;
  if designated_id is distinct from kento_id then
    perform public.set_instance_business_actor(kento_id, settings_version,
      kento_id, 'Development identity reset');
  end if;
end $$;

-- Clear compatibility links before deleting Telegram rows; these references
-- otherwise prevent a safe FK-respecting purge.
update public.users set legacy_telegram_user_id = null
  where legacy_telegram_user_id is not null;
delete from public.telegram_users;

delete from public.system_authority_assignments
  where user_id <> (select user_id from public.admin_credentials
    where email = 'owner@sotoayam.local') or revoked_at is not null;
update public.system_authority_assignments set
  granted_by_user_id = null, revoked_by_user_id = null
  where user_id = (select user_id from public.admin_credentials
    where email = 'owner@sotoayam.local')
    and (granted_by_user_id is distinct from user_id or revoked_by_user_id is not null);
delete from public.admin_credentials
  where email <> 'owner@sotoayam.local';
update public.instance_settings set updated_by_user_id = null
  where updated_by_user_id is distinct from business_actor_user_id;
delete from public.users where id <> (select user_id from public.admin_credentials
  where email = 'owner@sotoayam.local');

do $$
declare kento_id bigint;
begin
  select user_id into kento_id from public.admin_credentials
    where email = 'owner@sotoayam.local';
  if (select count(*) from public.users) <> 1
    or (select count(*) from public.admin_credentials) <> 1
    or (select count(*) from public.system_authority_assignments) <> 1
    or (select count(*) from public.users u join public.roles r on r.id = u.role_id
      where r.code = 'OWNER' and u.active) <> 1
    or (select business_actor_user_id from public.instance_settings where singleton_key) is distinct from kento_id
    or not public.is_effective_system_admin(kento_id)
    or (select count(*) from public.telegram_users) <> 0
    or (select count(*) from public.tasks) <> 0 then
    raise exception 'RESET_POSTCONDITION_FAILED';
  end if;
  insert into public.audit_logs (actor_type, actor_user_id, action, object_type,
    object_id, source, after_state)
  values ('USER', kento_id, 'DEVELOPMENT_DATA_RESET', 'INSTANCE', 'development',
    'dev_reset_data', jsonb_build_object('remaining_users', 1));
end $$;

commit;
