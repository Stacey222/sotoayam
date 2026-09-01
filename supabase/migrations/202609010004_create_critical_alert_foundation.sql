begin;

create table public.critical_alerts (
  id bigint generated always as identity primary key,
  alert_type text not null check (alert_type in (
    'TASK_OVERDUE', 'TASK_BLOCKED_TOO_LONG',
    'NOTIFICATION_DELIVERY_FAILURE', 'REMINDER_SCHEDULER_UNHEALTHY'
  )),
  severity text not null check (severity in ('WARNING', 'HIGH', 'CRITICAL')),
  source_type text not null check (source_type in ('TASK', 'NOTIFICATION_DELIVERY', 'REMINDER_SCHEDULER')),
  source_reference text not null check (length(trim(source_reference)) between 1 and 200),
  owner_division_id bigint references public.divisions (id),
  task_id bigint references public.tasks (id),
  status text not null default 'OPEN' check (status in ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')),
  dimensions text[] not null check (
    cardinality(dimensions) > 0
    and dimensions <@ array['VALUE', 'BASELINE', 'DURATION', 'BUSINESS_IMPACT']::text[]
  ),
  first_detected_at timestamptz not null,
  last_detected_at timestamptz not null,
  occurrence_count integer not null default 1 check (occurrence_count > 0),
  dedupe_key text not null check (length(dedupe_key) = 64),
  acknowledged_at timestamptz,
  acknowledged_by_user_id bigint references public.users (id),
  resolved_at timestamptz,
  summary text not null check (length(trim(summary)) between 1 and 500),
  safe_context jsonb not null default '{}'::jsonb check (jsonb_typeof(safe_context) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (last_detected_at >= first_detected_at),
  check ((acknowledged_at is null) = (acknowledged_by_user_id is null)),
  check (status <> 'ACKNOWLEDGED' or acknowledged_at is not null),
  check ((status = 'RESOLVED') = (resolved_at is not null))
);

create unique index critical_alerts_active_dedupe_uidx
  on public.critical_alerts (dedupe_key)
  where status in ('OPEN', 'ACKNOWLEDGED');
create index critical_alerts_active_severity_idx
  on public.critical_alerts (severity, last_detected_at desc)
  where status in ('OPEN', 'ACKNOWLEDGED');
create index critical_alerts_task_id_idx on public.critical_alerts (task_id) where task_id is not null;

create table public.critical_alert_evaluator_state (
  singleton_key text primary key default 'CRITICAL_ALERT' check (singleton_key = 'CRITICAL_ALERT'),
  lease_owner uuid,
  lease_until timestamptz,
  last_started_at timestamptz,
  last_completed_at timestamptz,
  last_status text not null default 'IDLE' check (last_status in ('IDLE', 'RUNNING', 'COMPLETED', 'FAILED')),
  last_candidates integer not null default 0 check (last_candidates >= 0),
  last_alerts_refreshed integer not null default 0 check (last_alerts_refreshed >= 0),
  last_alerts_resolved integer not null default 0 check (last_alerts_resolved >= 0),
  last_error_code text check (last_error_code is null or length(last_error_code) between 1 and 100),
  updated_at timestamptz not null default now()
);

insert into public.critical_alert_evaluator_state (singleton_key) values ('CRITICAL_ALERT');

create trigger set_critical_alerts_updated_at before update on public.critical_alerts
for each row execute function public.set_governance_updated_at();
create trigger set_critical_alert_evaluator_state_updated_at before update on public.critical_alert_evaluator_state
for each row execute function public.set_governance_updated_at();

alter table public.critical_alerts enable row level security;
alter table public.critical_alert_evaluator_state enable row level security;

create or replace function public.try_acquire_critical_alert_lease(p_owner uuid, p_lease_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare affected integer := 0;
begin
  if p_owner is null or p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception using errcode = '22023', message = 'Invalid critical alert lease request';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('gwens_critical_alert_evaluator', 0));
  update public.critical_alert_evaluator_state set
    lease_owner = p_owner, lease_until = now() + make_interval(secs => p_lease_seconds),
    last_started_at = now(), last_status = 'RUNNING', last_error_code = null
  where singleton_key = 'CRITICAL_ALERT'
    and (lease_until is null or lease_until <= now() or lease_owner = p_owner);
  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

create or replace function public.upsert_critical_alert(
  p_alert_type text, p_severity text, p_source_type text, p_source_reference text,
  p_owner_division_id bigint, p_task_id bigint, p_dimensions text[], p_detected_at timestamptz,
  p_dedupe_key text, p_summary text, p_safe_context jsonb
)
returns public.critical_alerts
language plpgsql
security definer
set search_path = ''
as $$
declare result public.critical_alerts;
begin
  insert into public.critical_alerts (
    alert_type, severity, source_type, source_reference, owner_division_id, task_id,
    dimensions, first_detected_at, last_detected_at, dedupe_key, summary, safe_context
  ) values (
    p_alert_type, p_severity, p_source_type, trim(p_source_reference), p_owner_division_id, p_task_id,
    p_dimensions, p_detected_at, p_detected_at, p_dedupe_key, trim(p_summary), p_safe_context
  ) on conflict (dedupe_key) where status in ('OPEN', 'ACKNOWLEDGED') do update set
    severity = excluded.severity, owner_division_id = excluded.owner_division_id, task_id = excluded.task_id,
    dimensions = excluded.dimensions, last_detected_at = excluded.last_detected_at,
    occurrence_count = critical_alerts.occurrence_count + 1, summary = excluded.summary, safe_context = excluded.safe_context
  returning * into result;
  if result.occurrence_count = 1 then
    insert into public.audit_logs (actor_type, action, object_type, object_id, after_state, source)
    values ('SYSTEM', 'CRITICAL_ALERT_OPENED', 'CRITICAL_ALERT', result.id::text,
      jsonb_build_object('alert_type', result.alert_type, 'severity', result.severity, 'status', result.status),
      'critical_alert_evaluator');
  end if;
  return result;
end;
$$;

create or replace function public.resolve_stale_critical_alerts(
  p_owner uuid, p_seen_dedupe_keys text[], p_evaluated_types text[], p_resolved_at timestamptz
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare item record;
declare resolved_count integer := 0;
begin
  if not exists (
    select 1 from public.critical_alert_evaluator_state
    where singleton_key = 'CRITICAL_ALERT' and lease_owner = p_owner and lease_until > now()
  ) then raise exception using errcode = '55000', message = 'Critical alert evaluator lease is not held'; end if;
  for item in
    update public.critical_alerts set status = 'RESOLVED', resolved_at = p_resolved_at
    where status in ('OPEN', 'ACKNOWLEDGED') and alert_type = any(p_evaluated_types)
      and not (dedupe_key = any(coalesce(p_seen_dedupe_keys, array[]::text[])))
    returning id, alert_type, severity
  loop
    resolved_count := resolved_count + 1;
    insert into public.audit_logs (actor_type, action, object_type, object_id, after_state, source)
    values ('SYSTEM', 'CRITICAL_ALERT_RESOLVED', 'CRITICAL_ALERT', item.id::text,
      jsonb_build_object('alert_type', item.alert_type, 'severity', item.severity, 'status', 'RESOLVED'),
      'critical_alert_evaluator');
  end loop;
  return resolved_count;
end;
$$;

create or replace function public.complete_critical_alert_run(
  p_owner uuid, p_status text, p_candidates integer, p_refreshed integer,
  p_resolved integer, p_error_code text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare affected integer := 0;
begin
  if p_status not in ('COMPLETED', 'FAILED') then
    raise exception using errcode = '22023', message = 'Invalid critical alert completion status';
  end if;
  update public.critical_alert_evaluator_state set
    lease_owner = null, lease_until = null, last_completed_at = now(), last_status = p_status,
    last_candidates = greatest(p_candidates, 0), last_alerts_refreshed = greatest(p_refreshed, 0),
    last_alerts_resolved = greatest(p_resolved, 0), last_error_code = nullif(trim(p_error_code), '')
  where singleton_key = 'CRITICAL_ALERT' and lease_owner = p_owner;
  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

create or replace function public.acknowledge_critical_alert(p_alert_id bigint, p_actor_user_id bigint)
returns public.critical_alerts
language plpgsql
security definer
set search_path = ''
as $$
declare result public.critical_alerts;
declare previous_status text;
begin
  if not exists (
    select 1 from public.users join public.roles on roles.id = users.role_id
    where users.id = p_actor_user_id and users.active and roles.code = 'OWNER'
  ) then raise exception using errcode = '42501', message = 'Active OWNER authority is required'; end if;
  select status into previous_status from public.critical_alerts where id = p_alert_id and status in ('OPEN', 'ACKNOWLEDGED') for update;
  update public.critical_alerts set
    status = 'ACKNOWLEDGED', acknowledged_at = coalesce(acknowledged_at, now()),
    acknowledged_by_user_id = coalesce(acknowledged_by_user_id, p_actor_user_id)
  where id = p_alert_id and status in ('OPEN', 'ACKNOWLEDGED') returning * into result;
  if result.id is null then raise exception using errcode = 'P0002', message = 'Active critical alert not found'; end if;
  if previous_status = 'OPEN' then
    insert into public.audit_logs (actor_type, actor_user_id, action, object_type, object_id, after_state, source)
    values ('USER', p_actor_user_id, 'CRITICAL_ALERT_ACKNOWLEDGED', 'CRITICAL_ALERT', result.id::text,
      jsonb_build_object('status', result.status), 'owner_alert_api');
  end if;
  return result;
end;
$$;

revoke all on function public.try_acquire_critical_alert_lease(uuid, integer) from public, anon, authenticated;
revoke all on function public.upsert_critical_alert(text, text, text, text, bigint, bigint, text[], timestamptz, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.resolve_stale_critical_alerts(uuid, text[], text[], timestamptz) from public, anon, authenticated;
revoke all on function public.complete_critical_alert_run(uuid, text, integer, integer, integer, text) from public, anon, authenticated;
revoke all on function public.acknowledge_critical_alert(bigint, bigint) from public, anon, authenticated;
grant execute on function public.try_acquire_critical_alert_lease(uuid, integer) to service_role;
grant execute on function public.upsert_critical_alert(text, text, text, text, bigint, bigint, text[], timestamptz, text, text, jsonb) to service_role;
grant execute on function public.resolve_stale_critical_alerts(uuid, text[], text[], timestamptz) to service_role;
grant execute on function public.complete_critical_alert_run(uuid, text, integer, integer, integer, text) to service_role;
grant execute on function public.acknowledge_critical_alert(bigint, bigint) to service_role;

comment on table public.critical_alerts is 'Deterministic, durable critical signal lifecycle; alerts never mutate Task lifecycle.';
comment on column public.critical_alerts.safe_context is 'Business-safe structured context only; no raw errors, secrets, or external channel identifiers.';

commit;
