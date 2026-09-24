begin;

do $$
declare
  kento_id bigint;
  division_id bigint;
  staff_id bigint;
  admin_id bigint;
  dummy_user_id bigint;
begin
  select c.user_id, u.division_id into kento_id, division_id
    from public.admin_credentials c join public.users u on u.id = c.user_id
    where c.email = 'owner@sotoayam.local';
  if kento_id is null or (select count(*) from public.users) <> 1
      or not public.is_effective_system_admin(kento_id)
      or (select business_actor_user_id from public.instance_settings where singleton_key)
        is distinct from kento_id then
    raise exception 'SEED_REQUIRES_COMPLETED_DEVELOPMENT_RESET';
  end if;
  select id into staff_id from public.roles where code = 'STAFF' and active;
  select id into admin_id from public.roles where code = 'ADMIN' and active;
  if staff_id is null or admin_id is null then
    raise exception 'SEED_BASELINE_ROLES_REQUIRED';
  end if;
  insert into public.users (display_name, division_id, role_id, active)
    values ('Dummy User', division_id, staff_id, true) returning id into dummy_user_id;
  perform public.grant_admin_login(dummy_user_id, 'dummy.user@example.invalid',
    'Development dummy seed', 'scrypt', '__DUMMY_USER_HASH__', kento_id);
  perform public.create_administrator_account('Dummy Admin',
    'dummy.admin@example.invalid', division_id, admin_id, false,
    'Development dummy seed', 'scrypt', '__DUMMY_ADMIN_HASH__', kento_id);
  if (select count(*) from public.users) <> 3
      or (select count(*) from public.admin_credentials) <> 3
      or (select count(*) from public.system_authority_assignments where revoked_at is null) <> 1
      or (select count(*) from public.user_channels) <> 0
      or (select count(*) from public.telegram_users) <> 0 then
    raise exception 'SEED_POSTCONDITION_FAILED';
  end if;
end $$;

commit;
