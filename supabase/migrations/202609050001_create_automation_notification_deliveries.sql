begin;

create table public.automation_notification_events (
  id bigint generated always as identity primary key,
  external_event_id text unique check (external_event_id is null or length(trim(external_event_id)) between 1 and 200),
  event_type text not null check (event_type in ('STOCK_CRITICAL', 'PURCHASE_RECOMMENDATION', 'SALES_FOLLOWUP', 'MARKETING_ALERT', 'CONTENT_OPPORTUNITY', 'OWNER_DAILY_REPORT', 'SYSTEM_ERROR')),
  message text not null check (length(trim(message)) between 1 and 4096),
  payload_hash text not null check (length(payload_hash) = 64),
  recipient_count integer not null check (recipient_count >= 0),
  created_at timestamptz not null default now()
);

create table public.automation_notification_deliveries (
  id bigint generated always as identity primary key,
  event_id bigint not null references public.automation_notification_events (id),
  recipient_telegram_user_id bigint not null references public.telegram_users (id),
  telegram_chat_id bigint not null,
  state text not null default 'PENDING' check (state in ('PENDING', 'PROCESSING', 'DELIVERED', 'FAILED')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 5),
  max_attempts integer not null default 3 check (max_attempts between 1 and 5),
  next_attempt_at timestamptz,
  delivered_at timestamptz,
  failure_class text check (failure_class is null or failure_class in ('TRANSIENT', 'PERMANENT')),
  failure_code text check (failure_code is null or length(trim(failure_code)) between 1 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id, recipient_telegram_user_id),
  check ((state = 'DELIVERED') = (delivered_at is not null)),
  check (state <> 'PENDING' or next_attempt_at is not null)
);

create index automation_notification_deliveries_due_idx on public.automation_notification_deliveries (next_attempt_at)
  where state in ('PENDING', 'PROCESSING');
create index automation_notification_deliveries_event_idx on public.automation_notification_deliveries (event_id, state);

create trigger set_automation_notification_deliveries_updated_at before update on public.automation_notification_deliveries
for each row execute function public.set_governance_updated_at();

create or replace function public.create_automation_notification_event(
  p_external_event_id text, p_event_type text, p_message text, p_payload_hash text, p_recipients jsonb
)
returns table(event_id bigint, created boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare new_id bigint;
declare existing_hash text;
begin
  if p_event_type not in ('STOCK_CRITICAL', 'PURCHASE_RECOMMENDATION', 'SALES_FOLLOWUP', 'MARKETING_ALERT', 'CONTENT_OPPORTUNITY', 'OWNER_DAILY_REPORT', 'SYSTEM_ERROR')
    or length(trim(p_message)) not between 1 and 4096
    or length(p_payload_hash) <> 64
    or jsonb_typeof(p_recipients) <> 'array' then
    raise exception using errcode = '22023', message = 'Invalid automation notification event';
  end if;

  insert into public.automation_notification_events (external_event_id, event_type, message, payload_hash, recipient_count)
  values (nullif(trim(p_external_event_id), ''), p_event_type, trim(p_message), p_payload_hash, jsonb_array_length(p_recipients))
  on conflict (external_event_id) do nothing
  returning id into new_id;

  if new_id is null then
    select id, payload_hash into new_id, existing_hash
    from public.automation_notification_events
    where external_event_id = nullif(trim(p_external_event_id), '');
    if existing_hash <> p_payload_hash then
      raise exception using errcode = '22023', message = 'Conflicting automation notification event';
    end if;
    return query select new_id, false;
    return;
  end if;

  insert into public.automation_notification_deliveries (
    event_id, recipient_telegram_user_id, telegram_chat_id, state, next_attempt_at
  )
  select new_id, recipient.telegram_user_id, recipient.telegram_chat_id, 'PENDING', now()
  from jsonb_to_recordset(p_recipients) as recipient(telegram_user_id bigint, telegram_chat_id bigint);

  return query select new_id, true;
end;
$$;

revoke all on function public.create_automation_notification_event(text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.create_automation_notification_event(text, text, text, text, jsonb) to service_role;

alter table public.automation_notification_events enable row level security;
alter table public.automation_notification_deliveries enable row level security;

comment on table public.automation_notification_events is 'Durable internal automation notification events; external event IDs prevent duplicate delivery.';
comment on table public.automation_notification_deliveries is 'Per-recipient delivery state for internal automation notifications. Raw transport payloads are forbidden.';

commit;
