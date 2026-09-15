begin;

insert into public.role_permissions (role_id, permission_id)
select roles.id, permissions.id from public.roles roles
join public.permissions permissions on permissions.code = 'threshold.manage'
where roles.code = 'OWNER'
on conflict (role_id, permission_id) do nothing;

create table public.instance_settings (
  singleton_key boolean primary key default true check (singleton_key),
  business_time_zone text,
  reminder_scheduler_interval_seconds integer,
  critical_alert_policy jsonb,
  business_actor_user_id bigint references public.users(id) on delete restrict,
  version bigint not null default 0 check (version >= 0),
  updated_at timestamptz,
  updated_by_user_id bigint references public.users(id),
  check ((business_time_zone is null and reminder_scheduler_interval_seconds is null and critical_alert_policy is null)
    or (business_time_zone is not null and reminder_scheduler_interval_seconds is not null and critical_alert_policy is not null)),
  check (reminder_scheduler_interval_seconds is null or reminder_scheduler_interval_seconds between 60 and 3600)
);
alter table public.instance_settings enable row level security;
revoke all on table public.instance_settings from public, anon, authenticated, service_role;
insert into public.instance_settings (singleton_key) values (true);

create function public.is_valid_critical_alert_policy(p_policy jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select jsonb_typeof(p_policy) = 'object'
    and (select array_agg(k order by k) from jsonb_object_keys(p_policy) k) = array['blocked','overdue','scheduler']
    and (select array_agg(k order by k) from jsonb_object_keys(p_policy->'overdue') k) = array['criticalHours','highHours','warningHours']
    and (select array_agg(k order by k) from jsonb_object_keys(p_policy->'blocked') k) = array['criticalHours','highHours','warningHours']
    and (select array_agg(k order by k) from jsonb_object_keys(p_policy->'scheduler') k) = array['criticalMinutes','staleMinutes']
    and (p_policy->'overdue'->>'warningHours') ~ '^[0-9]+$'
    and (p_policy->'overdue'->>'highHours') ~ '^[0-9]+$'
    and (p_policy->'overdue'->>'criticalHours') ~ '^[0-9]+$'
    and (p_policy->'blocked'->>'warningHours') ~ '^[0-9]+$'
    and (p_policy->'blocked'->>'highHours') ~ '^[0-9]+$'
    and (p_policy->'blocked'->>'criticalHours') ~ '^[0-9]+$'
    and (p_policy->'scheduler'->>'staleMinutes') ~ '^[0-9]+$'
    and (p_policy->'scheduler'->>'criticalMinutes') ~ '^[0-9]+$'
    and (p_policy->'overdue'->>'warningHours')::int between 1 and 8760
    and (p_policy->'overdue'->>'warningHours')::int < (p_policy->'overdue'->>'highHours')::int
    and (p_policy->'overdue'->>'highHours')::int < (p_policy->'overdue'->>'criticalHours')::int
    and (p_policy->'overdue'->>'criticalHours')::int <= 8760
    and (p_policy->'blocked'->>'warningHours')::int between 1 and 8760
    and (p_policy->'blocked'->>'warningHours')::int < (p_policy->'blocked'->>'highHours')::int
    and (p_policy->'blocked'->>'highHours')::int < (p_policy->'blocked'->>'criticalHours')::int
    and (p_policy->'blocked'->>'criticalHours')::int <= 8760
    and (p_policy->'scheduler'->>'staleMinutes')::int between 1 and 8760
    and (p_policy->'scheduler'->>'staleMinutes')::int < (p_policy->'scheduler'->>'criticalMinutes')::int
    and (p_policy->'scheduler'->>'criticalMinutes')::int <= 8760;
$$;

create function public._business_actor_state_eligible(p_user_id bigint, p_active boolean, p_division_id bigint, p_role_id bigint)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_active and p_division_id is not null and p_role_id is not null
    and exists (select 1 from public.divisions d where d.id=p_division_id and d.active)
    and exists (select 1 from public.roles r where r.id=p_role_id and r.active)
    and exists (select 1 from public.admin_credentials c where c.user_id=p_user_id and not c.password_change_required)
    and 7 = (select count(distinct p.code) from public.role_permissions rp join public.permissions p on p.id=rp.permission_id and p.active
      where rp.role_id=p_role_id and p.code in ('report.view_cross_division','alert.view_critical','alert.acknowledge',
        'approval.view','approval.decide','automation_status.view_business','threshold.manage'));
$$;
create function public.is_business_actor_eligible(p_user_id bigint)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select public._business_actor_state_eligible(u.id,u.active,u.division_id,u.role_id)
    from public.users u where u.id=p_user_id), false);
$$;

do $backfill$
declare candidate bigint;
begin
  select min(u.id) into candidate from public.users u join public.roles r on r.id=u.role_id
  where r.code='OWNER' and public.is_business_actor_eligible(u.id)
  having count(*)=1;
  if candidate is not null then update public.instance_settings set business_actor_user_id=candidate where singleton_key; end if;
end $backfill$;

create function public.get_instance_settings()
returns table (business_time_zone text, reminder_scheduler_interval_seconds integer, critical_alert_policy jsonb,
  business_actor_user_id bigint, business_actor_display_name text, business_actor_eligible boolean,
  version bigint, updated_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select s.business_time_zone,s.reminder_scheduler_interval_seconds,s.critical_alert_policy,s.business_actor_user_id,
    u.display_name, coalesce(public.is_business_actor_eligible(s.business_actor_user_id),false),s.version,s.updated_at
  from public.instance_settings s left join public.users u on u.id=s.business_actor_user_id where s.singleton_key;
$$;

create function public.update_instance_runtime_settings(p_actor_user_id bigint, p_expected_version bigint,
  p_business_time_zone text, p_reminder_scheduler_interval_seconds integer, p_critical_alert_policy jsonb, p_reason text)
returns table (business_time_zone text, reminder_scheduler_interval_seconds integer, critical_alert_policy jsonb,
  business_actor_user_id bigint, business_actor_display_name text, business_actor_eligible boolean,
  version bigint, updated_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare before_row public.instance_settings%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('sotoayam_business_actor_invariant',0));
  if not exists (select 1 from public.users u join public.divisions d on d.id=u.division_id and d.active
    join public.roles r on r.id=u.role_id and r.active join public.role_permissions rp on rp.role_id=r.id
    join public.permissions p on p.id=rp.permission_id and p.active and p.code='threshold.manage'
    where u.id=p_actor_user_id and u.active) then raise exception 'RUNTIME_SETTINGS_FORBIDDEN' using errcode='42501'; end if;
  if p_business_time_zone is null or length(p_business_time_zone)>100 or p_business_time_zone<>trim(p_business_time_zone)
    or p_business_time_zone ~ '[[:cntrl:]]' or not exists (select 1 from pg_catalog.pg_timezone_names where name=p_business_time_zone)
    or p_reminder_scheduler_interval_seconds not between 60 and 3600 or not coalesce(public.is_valid_critical_alert_policy(p_critical_alert_policy),false)
    or p_reason is null or length(trim(p_reason)) not between 1 and 500 then raise exception 'VALIDATION_ERROR' using errcode='22023'; end if;
  select * into before_row from public.instance_settings where singleton_key for update;
  if before_row.version<>p_expected_version then raise exception 'SETTINGS_VERSION_CONFLICT' using errcode='P0001'; end if;
  if before_row.business_time_zone is not distinct from p_business_time_zone
    and before_row.reminder_scheduler_interval_seconds is not distinct from p_reminder_scheduler_interval_seconds
    and before_row.critical_alert_policy is not distinct from p_critical_alert_policy then raise exception 'SETTINGS_UNCHANGED' using errcode='P0001'; end if;
  update public.instance_settings s set business_time_zone=p_business_time_zone,
    reminder_scheduler_interval_seconds=p_reminder_scheduler_interval_seconds,critical_alert_policy=p_critical_alert_policy,
    version=s.version+1,updated_at=now(),updated_by_user_id=p_actor_user_id where s.singleton_key;
  insert into public.audit_logs(actor_type,actor_user_id,action,object_type,object_id,before_state,after_state,source)
  values ('USER',p_actor_user_id,'RUNTIME_SETTINGS_UPDATED','INSTANCE_SETTINGS','singleton',
    jsonb_build_object('version',before_row.version,'business_time_zone',before_row.business_time_zone,
      'reminder_scheduler_interval_seconds',before_row.reminder_scheduler_interval_seconds,'critical_alert_policy',before_row.critical_alert_policy),
    jsonb_build_object('version',before_row.version+1,'business_time_zone',p_business_time_zone,
      'reminder_scheduler_interval_seconds',p_reminder_scheduler_interval_seconds,'critical_alert_policy',p_critical_alert_policy,'reason',trim(p_reason)),
    'runtime_settings_api');
  return query select * from public.get_instance_settings();
end; $$;

create function public.set_instance_business_actor(p_actor_user_id bigint,p_expected_version bigint,p_business_actor_user_id bigint,p_reason text)
returns table (business_time_zone text, reminder_scheduler_interval_seconds integer, critical_alert_policy jsonb,
  business_actor_user_id bigint, business_actor_display_name text, business_actor_eligible boolean,
  version bigint, updated_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare before_row public.instance_settings%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('gwens_system_admin_invariant',0));
  perform pg_advisory_xact_lock(hashtextextended('sotoayam_business_actor_invariant',0));
  if not exists (select 1 from public.system_authority_assignments a join public.users u on u.id=a.user_id and u.active
    join public.divisions d on d.id=u.division_id and d.active and d.grants_system_authority
    where a.user_id=p_actor_user_id and a.authority_code='SYSTEM_ADMIN' and a.revoked_at is null)
    then raise exception 'SYSTEM_ADMIN_REQUIRED' using errcode='42501'; end if;
  if p_reason is null or length(trim(p_reason)) not between 1 and 500 then raise exception 'VALIDATION_ERROR' using errcode='22023'; end if;
  if not public.is_business_actor_eligible(p_business_actor_user_id) then raise exception 'BUSINESS_ACTOR_INELIGIBLE' using errcode='P0001'; end if;
  select * into before_row from public.instance_settings where singleton_key for update;
  if before_row.version<>p_expected_version then raise exception 'SETTINGS_VERSION_CONFLICT' using errcode='P0001'; end if;
  if before_row.business_actor_user_id is not distinct from p_business_actor_user_id then raise exception 'SETTINGS_UNCHANGED' using errcode='P0001'; end if;
  update public.instance_settings s set business_actor_user_id=p_business_actor_user_id,version=s.version+1,
    updated_at=now(),updated_by_user_id=p_actor_user_id where s.singleton_key;
  insert into public.audit_logs(actor_type,actor_user_id,action,object_type,object_id,before_state,after_state,source)
  values ('USER',p_actor_user_id,'BUSINESS_ACTOR_CHANGED','INSTANCE_SETTINGS','singleton',
    jsonb_build_object('version',before_row.version,'business_actor_user_id',before_row.business_actor_user_id),
    jsonb_build_object('version',before_row.version+1,'business_actor_user_id',p_business_actor_user_id,'reason',trim(p_reason)),
    'runtime_settings_api');
  return query select * from public.get_instance_settings();
end; $$;

create function public.protect_designated_business_actor_user() returns trigger language plpgsql set search_path='' as $$
declare designated_id bigint;
begin
  if new.active is distinct from old.active or new.division_id is distinct from old.division_id or new.role_id is distinct from old.role_id then
    perform pg_advisory_xact_lock(hashtextextended('sotoayam_business_actor_invariant',0));
    select business_actor_user_id into designated_id from public.instance_settings where singleton_key for update;
    if designated_id=old.id and not public._business_actor_state_eligible(new.id,new.active,new.division_id,new.role_id)
      then raise exception 'LAST_OWNER' using errcode='P0001'; end if;
  end if; return new;
end; $$;
create trigger protect_designated_business_actor_user before update of active,division_id,role_id on public.users
for each row execute function public.protect_designated_business_actor_user();

create function public.protect_designated_business_actor_division() returns trigger language plpgsql set search_path='' as $$
declare designated_division_id bigint;
begin
  if old.active and not new.active then
    perform pg_advisory_xact_lock(hashtextextended('sotoayam_business_actor_invariant',0));
    select u.division_id into designated_division_id from public.instance_settings s left join public.users u on u.id=s.business_actor_user_id
      where s.singleton_key for update of s;
    if designated_division_id=old.id then raise exception 'LAST_OWNER' using errcode='P0001'; end if;
  end if; return new;
end; $$;
create trigger protect_designated_business_actor_division before update of active on public.divisions
for each row execute function public.protect_designated_business_actor_division();

create function public.protect_designated_business_actor_credential() returns trigger language plpgsql set search_path='' as $$
declare designated_id bigint;
begin
  if tg_op='DELETE' or (tg_op='UPDATE' and new.password_change_required) then
    perform pg_advisory_xact_lock(hashtextextended('sotoayam_business_actor_invariant',0));
    select business_actor_user_id into designated_id from public.instance_settings where singleton_key for update;
    if designated_id=old.user_id then raise exception 'LAST_OWNER' using errcode='P0001'; end if;
  end if; return case when tg_op='DELETE' then old else new end;
end; $$;
create trigger protect_designated_business_actor_credential before update of password_change_required or delete on public.admin_credentials
for each row execute function public.protect_designated_business_actor_credential();

revoke all on function public.is_valid_critical_alert_policy(jsonb) from public,anon,authenticated,service_role;
revoke all on function public._business_actor_state_eligible(bigint,boolean,bigint,bigint) from public,anon,authenticated,service_role;
revoke all on function public.is_business_actor_eligible(bigint) from public,anon,authenticated,service_role;
revoke all on function public.get_instance_settings() from public,anon,authenticated;
revoke all on function public.update_instance_runtime_settings(bigint,bigint,text,integer,jsonb,text) from public,anon,authenticated;
revoke all on function public.set_instance_business_actor(bigint,bigint,bigint,text) from public,anon,authenticated;
grant execute on function public.get_instance_settings() to service_role;
grant execute on function public.update_instance_runtime_settings(bigint,bigint,text,integer,jsonb,text) to service_role;
grant execute on function public.set_instance_business_actor(bigint,bigint,bigint,text) to service_role;

commit;
