begin;

create table public.notifications (
  id bigint generated always as identity primary key,
  task_id bigint not null references public.tasks (id),
  event_type text not null check (event_type in ('TASK_REMINDER', 'TASK_ESCALATION')),
  recipient_user_id bigint references public.users (id),
  routing_status text not null check (routing_status in ('ROUTED', 'UNROUTED')),
  routing_failure_code text check (routing_failure_code is null or routing_failure_code in (
    'UNASSIGNED', 'USER_INACTIVE', 'CHANNEL_MISSING', 'CHANNEL_AMBIGUOUS',
    'ESCALATION_UNROUTED', 'UNSUPPORTED_CHANNEL'
  )),
  dedupe_key text not null unique check (length(dedupe_key) = 64),
  message text not null check (length(trim(message)) between 1 and 1000),
  occurrence_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (
    (routing_status = 'ROUTED' and recipient_user_id is not null and routing_failure_code is null)
    or (routing_status = 'UNROUTED' and recipient_user_id is null and routing_failure_code is not null)
  )
);

create table public.notification_deliveries (
  id bigint generated always as identity primary key,
  notification_id bigint not null unique references public.notifications (id),
  channel text not null check (channel in ('TELEGRAM', 'WHATSAPP', 'EMAIL')),
  state text not null default 'PENDING'
    check (state in ('PENDING', 'PROCESSING', 'DELIVERED', 'FAILED', 'CANCELLED')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 5),
  max_attempts integer not null default 3 check (max_attempts between 1 and 5),
  scheduled_at timestamptz not null,
  next_attempt_at timestamptz,
  delivered_at timestamptz,
  failure_class text check (failure_class is null or failure_class in ('TRANSIENT', 'PERMANENT')),
  failure_code text check (failure_code is null or length(trim(failure_code)) between 1 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((state = 'DELIVERED') = (delivered_at is not null)),
  check (state <> 'PENDING' or next_attempt_at is not null)
);

create table public.task_reminder_states (
  task_id bigint primary key references public.tasks (id),
  last_reminder_at timestamptz,
  next_reminder_at timestamptz,
  reminder_count integer not null default 0 check (reminder_count >= 0),
  last_escalation_at timestamptz,
  next_escalation_at timestamptz,
  escalation_count integer not null default 0 check (escalation_count >= 0),
  last_evaluated_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.notification_routing_rules (
  id bigint generated always as identity primary key,
  event_type text not null check (event_type in ('TASK_ESCALATION')),
  owner_division_id bigint not null references public.divisions (id),
  priority text check (priority is null or priority in ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  recipient_strategy text not null default 'SPECIFIC_USER' check (recipient_strategy = 'SPECIFIC_USER'),
  recipient_user_id bigint not null references public.users (id),
  channel text not null default 'TELEGRAM' check (channel in ('TELEGRAM', 'WHATSAPP', 'EMAIL')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index notification_routing_rules_active_uidx
  on public.notification_routing_rules (event_type, owner_division_id, coalesce(priority, 'ALL'), channel)
  where active;

create table public.reminder_scheduler_state (
  singleton_key text primary key default 'TASK_REMINDER' check (singleton_key = 'TASK_REMINDER'),
  lease_owner uuid,
  lease_until timestamptz,
  last_started_at timestamptz,
  last_completed_at timestamptz,
  last_status text not null default 'IDLE' check (last_status in ('IDLE', 'RUNNING', 'COMPLETED', 'FAILED')),
  last_tasks_evaluated integer not null default 0 check (last_tasks_evaluated >= 0),
  last_candidates integer not null default 0 check (last_candidates >= 0),
  last_notifications_created integer not null default 0 check (last_notifications_created >= 0),
  last_deliveries_attempted integer not null default 0 check (last_deliveries_attempted >= 0),
  updated_at timestamptz not null default now()
);

insert into public.reminder_scheduler_state (singleton_key) values ('TASK_REMINDER');

create index notifications_task_id_created_at_idx on public.notifications (task_id, created_at desc);
create index notifications_routing_status_idx on public.notifications (routing_status, created_at desc);
create index notification_deliveries_due_idx on public.notification_deliveries (next_attempt_at)
  where state in ('PENDING', 'PROCESSING');
create index notification_deliveries_state_created_at_idx on public.notification_deliveries (state, created_at desc);
create index notification_routing_rules_owner_division_idx on public.notification_routing_rules (owner_division_id) where active;

create trigger set_notification_deliveries_updated_at before update on public.notification_deliveries
for each row execute function public.set_governance_updated_at();
create trigger set_task_reminder_states_updated_at before update on public.task_reminder_states
for each row execute function public.set_governance_updated_at();
create trigger set_notification_routing_rules_updated_at before update on public.notification_routing_rules
for each row execute function public.set_governance_updated_at();
create trigger set_reminder_scheduler_state_updated_at before update on public.reminder_scheduler_state
for each row execute function public.set_governance_updated_at();

create or replace function public.try_acquire_reminder_scheduler_lease(p_owner uuid, p_lease_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare affected integer := 0;
begin
  if p_owner is null or p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception using errcode = '22023', message = 'Invalid scheduler lease request';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('gwens_task_reminder_scheduler', 0));
  update public.reminder_scheduler_state set
    lease_owner = p_owner,
    lease_until = now() + make_interval(secs => p_lease_seconds),
    last_started_at = now(),
    last_status = 'RUNNING'
  where singleton_key = 'TASK_REMINDER'
    and (lease_until is null or lease_until <= now() or lease_owner = p_owner);
  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

create or replace function public.complete_reminder_scheduler_run(
  p_owner uuid, p_status text, p_tasks_evaluated integer, p_candidates integer,
  p_notifications_created integer, p_deliveries_attempted integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare affected integer := 0;
begin
  if p_status not in ('COMPLETED', 'FAILED') then
    raise exception using errcode = '22023', message = 'Invalid scheduler completion status';
  end if;
  update public.reminder_scheduler_state set
    lease_owner = null, lease_until = null, last_completed_at = now(), last_status = p_status,
    last_tasks_evaluated = greatest(p_tasks_evaluated, 0),
    last_candidates = greatest(p_candidates, 0),
    last_notifications_created = greatest(p_notifications_created, 0),
    last_deliveries_attempted = greatest(p_deliveries_attempted, 0)
  where singleton_key = 'TASK_REMINDER' and lease_owner = p_owner;
  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

create or replace function public.create_task_notification(
  p_task_id bigint, p_event_type text, p_recipient_user_id bigint, p_routing_failure_code text, p_dedupe_key text,
  p_message text, p_occurrence_at timestamptz, p_next_eligible_at timestamptz
)
returns table(notification_id bigint, created boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare new_id bigint;
begin
  if p_event_type not in ('TASK_REMINDER', 'TASK_ESCALATION')
    or length(p_dedupe_key) <> 64 or length(trim(p_message)) not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'Invalid notification intent';
  end if;
  insert into public.notifications (
    task_id, event_type, recipient_user_id, routing_status, routing_failure_code, dedupe_key, message, occurrence_at
  ) values (
    p_task_id, p_event_type, p_recipient_user_id,
    case when p_recipient_user_id is null then 'UNROUTED' else 'ROUTED' end,
    p_routing_failure_code, p_dedupe_key, trim(p_message), p_occurrence_at
  ) on conflict (dedupe_key) do nothing returning id into new_id;

  if new_id is null then
    select id into new_id from public.notifications where dedupe_key = p_dedupe_key;
    return query select new_id, false;
    return;
  end if;

  if p_recipient_user_id is not null then
    insert into public.notification_deliveries (
      notification_id, channel, state, scheduled_at, next_attempt_at
    ) values (new_id, 'TELEGRAM', 'PENDING', now(), now());
  end if;

  insert into public.task_reminder_states (
    task_id, last_reminder_at, next_reminder_at, reminder_count,
    last_escalation_at, next_escalation_at, escalation_count, last_evaluated_at
  ) values (
    p_task_id,
    case when p_event_type = 'TASK_REMINDER' then now() end,
    case when p_event_type = 'TASK_REMINDER' then p_next_eligible_at end,
    case when p_event_type = 'TASK_REMINDER' then 1 else 0 end,
    case when p_event_type = 'TASK_ESCALATION' then now() end,
    case when p_event_type = 'TASK_ESCALATION' then p_next_eligible_at end,
    case when p_event_type = 'TASK_ESCALATION' then 1 else 0 end,
    now()
  ) on conflict (task_id) do update set
    last_reminder_at = case when p_event_type = 'TASK_REMINDER' then now() else task_reminder_states.last_reminder_at end,
    next_reminder_at = case when p_event_type = 'TASK_REMINDER' then p_next_eligible_at else task_reminder_states.next_reminder_at end,
    reminder_count = task_reminder_states.reminder_count + case when p_event_type = 'TASK_REMINDER' then 1 else 0 end,
    last_escalation_at = case when p_event_type = 'TASK_ESCALATION' then now() else task_reminder_states.last_escalation_at end,
    next_escalation_at = case when p_event_type = 'TASK_ESCALATION' then p_next_eligible_at else task_reminder_states.next_escalation_at end,
    escalation_count = task_reminder_states.escalation_count + case when p_event_type = 'TASK_ESCALATION' then 1 else 0 end,
    last_evaluated_at = now();

  insert into public.audit_logs (actor_type, action, object_type, object_id, after_state, source)
  values ('SYSTEM', case when p_event_type = 'TASK_REMINDER' then 'REMINDER_INTENT_GENERATED' else 'ESCALATION_GENERATED' end,
    'NOTIFICATION', new_id::text,
    jsonb_build_object('task_id', p_task_id, 'event_type', p_event_type,
      'routing_status', case when p_recipient_user_id is null then 'UNROUTED' else 'ROUTED' end,
      'routing_failure_code', p_routing_failure_code),
    'reminder_scheduler');

  return query select new_id, true;
end;
$$;

revoke all on function public.try_acquire_reminder_scheduler_lease(uuid, integer) from public, anon, authenticated;
revoke all on function public.complete_reminder_scheduler_run(uuid, text, integer, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.create_task_notification(bigint, text, bigint, text, text, text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.try_acquire_reminder_scheduler_lease(uuid, integer) to service_role;
grant execute on function public.complete_reminder_scheduler_run(uuid, text, integer, integer, integer, integer) to service_role;
grant execute on function public.create_task_notification(bigint, text, bigint, text, text, text, timestamptz, timestamptz) to service_role;

alter table public.notifications enable row level security;
alter table public.notification_deliveries enable row level security;
alter table public.task_reminder_states enable row level security;
alter table public.notification_routing_rules enable row level security;
alter table public.reminder_scheduler_state enable row level security;

comment on table public.notifications is 'Transport-neutral task notification intents with durable deduplication.';
comment on table public.notification_deliveries is 'Persisted channel delivery state and bounded retry metadata; raw transport payloads are forbidden.';
comment on table public.task_reminder_states is 'Restart-safe reminder and escalation eligibility state per task.';
comment on table public.notification_routing_rules is 'Explicit notification routing. Slice 7 seeds no speculative escalation recipients.';
comment on table public.reminder_scheduler_state is 'Singleton durable scheduler lease and safe operational summary.';

commit;
