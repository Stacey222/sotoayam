begin;

create table public.notification_events (
  id bigint generated always as identity primary key,
  source text not null default 'INTERNAL_API'
    check (source ~ '^[A-Z][A-Z0-9_]{0,49}$'),
  external_event_id text not null
    check (length(external_event_id) between 1 and 200
      and external_event_id = trim(external_event_id)
      and external_event_id !~ '[[:cntrl:]]'),
  identity_origin text not null check (identity_origin in ('CALLER', 'GENERATED')),
  event_type text not null check (event_type in (
    'STOCK_CRITICAL', 'PURCHASE_RECOMMENDATION', 'SALES_FOLLOWUP', 'MARKETING_ALERT',
    'CONTENT_OPPORTUNITY', 'OWNER_DAILY_REPORT', 'SYSTEM_ERROR'
  )),
  payload_hash text not null check (length(payload_hash) = 64),
  message text not null check (length(trim(message)) between 1 and 4096),
  recipient_count integer not null default 0 check (recipient_count >= 0),
  routed_count integer not null default 0 check (routed_count >= 0),
  dispatched_at timestamptz,
  dispatch_sent integer not null default 0 check (dispatch_sent >= 0),
  dispatch_failed integer not null default 0 check (dispatch_failed >= 0),
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint notification_events_identity_uidx unique (source, external_event_id)
);

create index notification_events_received_at_idx on public.notification_events (received_at desc);
create index notification_events_undispatched_idx on public.notification_events (received_at)
  where dispatched_at is null;

alter table public.notification_events enable row level security;

alter table public.notifications
  add column notification_event_id bigint references public.notification_events (id);
alter table public.notifications alter column task_id drop not null;
alter table public.notifications add constraint notifications_single_parent check (
  (task_id is not null and notification_event_id is null)
  or (task_id is null and notification_event_id is not null)
);
create index notifications_event_id_idx on public.notifications (notification_event_id)
  where notification_event_id is not null;

do $$
declare constraint_name name;
begin
  select constraint_record.conname into strict constraint_name
  from pg_catalog.pg_constraint as constraint_record
  join pg_catalog.pg_attribute as attribute_record
    on attribute_record.attrelid = constraint_record.conrelid
   and attribute_record.attnum = any (constraint_record.conkey)
  where constraint_record.conrelid = 'public.notifications'::regclass
    and constraint_record.contype = 'c'
    and attribute_record.attname = 'event_type'
    and cardinality(constraint_record.conkey) = 1;
  execute format('alter table public.notifications drop constraint %I', constraint_name);
end;
$$;
alter table public.notifications add constraint notifications_event_type_allowed check (event_type in (
  'TASK_REMINDER', 'TASK_ESCALATION',
  'STOCK_CRITICAL', 'PURCHASE_RECOMMENDATION', 'SALES_FOLLOWUP', 'MARKETING_ALERT',
  'CONTENT_OPPORTUNITY', 'OWNER_DAILY_REPORT', 'SYSTEM_ERROR'
));

do $$
declare constraint_name name;
begin
  select constraint_record.conname into strict constraint_name
  from pg_catalog.pg_constraint as constraint_record
  join pg_catalog.pg_attribute as attribute_record
    on attribute_record.attrelid = constraint_record.conrelid
   and attribute_record.attnum = any (constraint_record.conkey)
  where constraint_record.conrelid = 'public.notifications'::regclass
    and constraint_record.contype = 'c'
    and attribute_record.attname = 'message'
    and cardinality(constraint_record.conkey) = 1;
  execute format('alter table public.notifications drop constraint %I', constraint_name);
end;
$$;
alter table public.notifications add constraint notifications_message_length
  check (length(trim(message)) between 1 and 4096);

do $$
declare constraint_name name;
begin
  select constraint_record.conname into strict constraint_name
  from pg_catalog.pg_constraint as constraint_record
  join pg_catalog.pg_attribute as attribute_record
    on attribute_record.attrelid = constraint_record.conrelid
   and attribute_record.attnum = any (constraint_record.conkey)
  where constraint_record.conrelid = 'public.notifications'::regclass
    and constraint_record.contype = 'c'
    and attribute_record.attname = 'routing_failure_code'
    and cardinality(constraint_record.conkey) = 1;
  execute format('alter table public.notifications drop constraint %I', constraint_name);
end;
$$;
alter table public.notifications add constraint notifications_routing_failure_code_allowed check (
  routing_failure_code is null or routing_failure_code in (
    'UNASSIGNED', 'USER_INACTIVE', 'CHANNEL_MISSING', 'CHANNEL_AMBIGUOUS',
    'ESCALATION_UNROUTED', 'UNSUPPORTED_CHANNEL', 'IDENTITY_UNMAPPED'
  )
);

create or replace function public.intake_notification_event(
  p_source text,
  p_external_event_id text,
  p_identity_origin text,
  p_event_type text,
  p_payload_hash text,
  p_message text,
  p_recipients jsonb
)
returns table (
  event_id bigint,
  created boolean,
  conflict boolean,
  recipient_count integer,
  routed_count integer,
  dispatched boolean,
  dispatch_sent integer,
  dispatch_failed integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  event_row record;
  recipient jsonb;
  normalized_user_id bigint;
  notification_id bigint;
  total_recipients integer := 0;
  total_routed integer := 0;
begin
  if p_source is null or p_source !~ '^[A-Z][A-Z0-9_]{0,49}$'
    or p_external_event_id is null or length(p_external_event_id) not between 1 and 200
    or p_external_event_id <> trim(p_external_event_id) or p_external_event_id ~ '[[:cntrl:]]'
    or p_identity_origin not in ('CALLER', 'GENERATED')
    or p_event_type not in (
      'STOCK_CRITICAL', 'PURCHASE_RECOMMENDATION', 'SALES_FOLLOWUP', 'MARKETING_ALERT',
      'CONTENT_OPPORTUNITY', 'OWNER_DAILY_REPORT', 'SYSTEM_ERROR'
    )
    or p_payload_hash is null or length(p_payload_hash) <> 64
    or p_message is null or length(trim(p_message)) not between 1 and 4096
    or jsonb_typeof(p_recipients) <> 'array'
    or jsonb_array_length(p_recipients) > 500 then
    raise exception using errcode = '22023', message = 'Invalid notification event intake';
  end if;

  insert into public.notification_events (
    source, external_event_id, identity_origin, event_type, payload_hash, message
  ) values (
    p_source, p_external_event_id, p_identity_origin, p_event_type, p_payload_hash, trim(p_message)
  )
  on conflict on constraint notification_events_identity_uidx
    do update set external_event_id = excluded.external_event_id
  returning notification_events.id, (xmax = 0) as inserted, notification_events.payload_hash,
    notification_events.recipient_count, notification_events.routed_count,
    notification_events.dispatched_at is not null as was_dispatched,
    notification_events.dispatch_sent, notification_events.dispatch_failed
  into event_row;

  if not event_row.inserted then
    return query select event_row.id, false, event_row.payload_hash <> p_payload_hash,
      event_row.recipient_count, event_row.routed_count, event_row.was_dispatched,
      event_row.dispatch_sent, event_row.dispatch_failed;
    return;
  end if;

  for recipient in select value from jsonb_array_elements(p_recipients)
  loop
    if jsonb_typeof(recipient) <> 'object'
      or (recipient->>'legacy_id') is null
      or (recipient->>'dedupe_key') is null
      or length(recipient->>'dedupe_key') <> 64 then
      raise exception using errcode = '22023', message = 'Invalid notification recipient expansion';
    end if;

    normalized_user_id := null;
    select normalized_user.id into normalized_user_id
    from public.users as normalized_user
    where normalized_user.legacy_telegram_user_id = (recipient->>'legacy_id')::bigint;

    insert into public.notifications (
      task_id, notification_event_id, event_type, recipient_user_id, routing_status,
      routing_failure_code, dedupe_key, message, occurrence_at
    ) values (
      null, event_row.id, p_event_type, normalized_user_id,
      case when normalized_user_id is null then 'UNROUTED' else 'ROUTED' end,
      case when normalized_user_id is null then 'IDENTITY_UNMAPPED' else null end,
      recipient->>'dedupe_key', trim(p_message), now()
    ) returning id into notification_id;

    total_recipients := total_recipients + 1;
    if normalized_user_id is not null then
      insert into public.notification_deliveries (
        notification_id, channel, state, scheduled_at, next_attempt_at
      ) values (notification_id, 'TELEGRAM', 'PENDING', now(), now());
      total_routed := total_routed + 1;
    end if;
  end loop;

  update public.notification_events set
    recipient_count = total_recipients,
    routed_count = total_routed
  where id = event_row.id;

  insert into public.audit_logs (actor_type, action, object_type, object_id, after_state, source)
  values (
    'SYSTEM', 'NOTIFICATION_EVENT_ACCEPTED', 'NOTIFICATION_EVENT', event_row.id::text,
    jsonb_build_object(
      'source', p_source,
      'event_type', p_event_type,
      'identity_origin', p_identity_origin,
      'recipient_count', total_recipients,
      'routed_count', total_routed
    ),
    'notification_intake'
  );

  return query select event_row.id, true, false, total_recipients, total_routed,
    false, 0, 0;
end;
$$;

revoke all on function public.intake_notification_event(text, text, text, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.intake_notification_event(text, text, text, text, text, text, jsonb)
  to service_role;

comment on table public.notification_events is
  'External notification intake intents. Raw caller metadata is never stored; only its payload hash contribution.';
comment on column public.notification_events.external_event_id is
  'Opaque caller correlation identity or generated compatibility surrogate; never credentials or personal data.';

commit;
