begin;

create table public.integration_credentials (
  id bigint generated always as identity primary key,
  integration_id bigint not null references public.task_source_integrations (id),
  selector text not null unique check (selector ~ '^[0-9abcdefghjkmnpqrstvwxyz]{16}$'),
  secret_hash text not null check (secret_hash ~ '^[0-9a-f]{64}$'),
  label text not null check (length(trim(label)) between 1 and 100),
  created_by_user_id bigint not null references public.users (id),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by_user_id bigint references public.users (id),
  revoked_reason text check (revoked_reason in ('ROTATED', 'COMPROMISED', 'DECOMMISSIONED', 'INTEGRATION_DISABLED')),
  rotation_of_credential_id bigint references public.integration_credentials (id),
  updated_at timestamptz not null default now(),
  check ((revoked_at is null and revoked_by_user_id is null and revoked_reason is null)
    or (revoked_at is not null and revoked_by_user_id is not null and revoked_reason is not null))
);

create index integration_credentials_active_idx on public.integration_credentials (integration_id)
  where revoked_at is null;

create trigger set_integration_credentials_updated_at
before update on public.integration_credentials
for each row execute function public.set_governance_updated_at();

alter table public.integration_credentials enable row level security;
revoke all on table public.integration_credentials from public, anon, authenticated, service_role;

alter table public.notification_events
  add column integration_id bigint references public.task_source_integrations (id);

create or replace function public.authenticate_integration_credential(
  p_selector text,
  p_secret_hash text,
  p_required_capability text
)
returns table (
  status text,
  credential_id bigint,
  integration_id bigint,
  code text,
  source text,
  requesting_division_id bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  credential_row record;
  dummy_matches boolean;
begin
  select credentials.id, credentials.integration_id, credentials.secret_hash,
    credentials.revoked_at, credentials.expires_at,
    integrations.code, integrations.source, integrations.requesting_division_id, integrations.active
  into credential_row
  from public.integration_credentials as credentials
  join public.task_source_integrations as integrations on integrations.id = credentials.integration_id
  where credentials.selector = p_selector;

  if not found then
    select p_secret_hash = repeat('0', 64) into dummy_matches;
    return query select 'UNKNOWN'::text, null::bigint, null::bigint, null::text, null::text, null::bigint;
    return;
  end if;
  if credential_row.secret_hash <> p_secret_hash then
    return query select 'BAD_SECRET'::text, null::bigint, null::bigint, null::text, null::text, null::bigint;
    return;
  end if;
  if credential_row.revoked_at is not null then
    return query select 'REVOKED'::text, null::bigint, null::bigint, null::text, null::text, null::bigint;
    return;
  end if;
  if credential_row.expires_at is not null and credential_row.expires_at <= now() then
    return query select 'EXPIRED'::text, null::bigint, null::bigint, null::text, null::text, null::bigint;
    return;
  end if;
  if not credential_row.active then
    return query select 'INTEGRATION_INACTIVE'::text, null::bigint, null::bigint, null::text, null::text, null::bigint;
    return;
  end if;
  if p_required_capability is not null and not exists (
    select 1 from public.integration_capabilities as capabilities
    where capabilities.integration_id = credential_row.integration_id
      and capabilities.capability_code = upper(trim(p_required_capability))
      and capabilities.revoked_at is null
  ) then
    return query select 'CAPABILITY_MISSING'::text, credential_row.id, credential_row.integration_id,
      credential_row.code, credential_row.source, credential_row.requesting_division_id;
    return;
  end if;

  update public.integration_credentials as credentials
  set last_used_at = now()
  where credentials.id = credential_row.id
    and (credentials.last_used_at is null or credentials.last_used_at <= now() - interval '60 seconds');

  return query select 'OK'::text, credential_row.id, credential_row.integration_id,
    credential_row.code, credential_row.source, credential_row.requesting_division_id;
end;
$$;

create or replace function public.create_integration_credential(
  p_integration_id bigint,
  p_selector text,
  p_secret_hash text,
  p_label text,
  p_expires_at timestamptz,
  p_rotation_of_credential_id bigint,
  p_actor_user_id bigint
)
returns table (
  id bigint, integration_id bigint, selector text, label text, created_at timestamptz,
  created_by_user_id bigint, last_used_at timestamptz, expires_at timestamptz,
  revoked_at timestamptz, revoked_reason text, rotation_of_credential_id bigint, status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare created public.integration_credentials%rowtype;
begin
  perform public.assert_it_system_admin(p_actor_user_id);
  if not exists (select 1 from public.task_source_integrations where task_source_integrations.id = p_integration_id) then
    raise exception using errcode = 'P0002', message = 'Integration identity not found';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception using errcode = '22023', message = 'Credential expiry must be in the future';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sotoayam_integration_credential:' || p_integration_id::text, 0));
  if (select count(*) from public.integration_credentials as credentials
      where credentials.integration_id = p_integration_id and credentials.revoked_at is null
        and (credentials.expires_at is null or credentials.expires_at > now())) >= 2 then
    raise exception using errcode = 'P0001', message = 'At most two active integration credentials are allowed';
  end if;
  if p_rotation_of_credential_id is not null and not exists (
    select 1 from public.integration_credentials as rotated
    where rotated.id = p_rotation_of_credential_id and rotated.integration_id = p_integration_id
  ) then
    raise exception using errcode = '22023', message = 'Rotation credential must belong to the integration';
  end if;
  insert into public.integration_credentials (
    integration_id, selector, secret_hash, label, created_by_user_id, expires_at, rotation_of_credential_id
  ) values (
    p_integration_id, p_selector, p_secret_hash, trim(p_label), p_actor_user_id, p_expires_at, p_rotation_of_credential_id
  ) returning * into created;
  insert into public.audit_logs (actor_type, actor_user_id, action, object_type, object_id, after_state, source)
  values ('USER', p_actor_user_id, 'INTEGRATION_CREDENTIAL_CREATED', 'INTEGRATION_CREDENTIAL', created.id::text,
    jsonb_build_object('selector', created.selector, 'integration_id', created.integration_id, 'label', created.label,
      'rotation_of_credential_id', created.rotation_of_credential_id, 'expires_at', created.expires_at),
    'integration_admin_api');
  return query select created.id, created.integration_id, created.selector, created.label, created.created_at,
    created.created_by_user_id, created.last_used_at, created.expires_at, created.revoked_at,
    created.revoked_reason, created.rotation_of_credential_id, 'ACTIVE'::text;
end;
$$;

create or replace function public.list_integration_credentials(p_integration_id bigint, p_actor_user_id bigint)
returns table (
  id bigint, integration_id bigint, selector text, label text, created_at timestamptz,
  created_by_user_id bigint, last_used_at timestamptz, expires_at timestamptz,
  revoked_at timestamptz, revoked_reason text, rotation_of_credential_id bigint, status text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_it_system_admin(p_actor_user_id);
  if not exists (select 1 from public.task_source_integrations where task_source_integrations.id = p_integration_id) then
    raise exception using errcode = 'P0002', message = 'Integration identity not found';
  end if;
  return query select credentials.id, credentials.integration_id, credentials.selector, credentials.label,
    credentials.created_at, credentials.created_by_user_id, credentials.last_used_at, credentials.expires_at,
    credentials.revoked_at, credentials.revoked_reason, credentials.rotation_of_credential_id,
    case when credentials.revoked_at is not null then 'REVOKED'
      when credentials.expires_at is not null and credentials.expires_at <= now() then 'EXPIRED'
      else 'ACTIVE' end::text
  from public.integration_credentials as credentials
  where credentials.integration_id = p_integration_id
  order by credentials.created_at desc, credentials.id desc;
end;
$$;

create or replace function public.revoke_integration_credential(
  p_credential_id bigint,
  p_reason text,
  p_grace_seconds integer,
  p_actor_user_id bigint
)
returns table (
  id bigint, integration_id bigint, selector text, label text, created_at timestamptz,
  created_by_user_id bigint, last_used_at timestamptz, expires_at timestamptz,
  revoked_at timestamptz, revoked_reason text, rotation_of_credential_id bigint, status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing public.integration_credentials%rowtype;
  updated public.integration_credentials%rowtype;
  requested_expiry timestamptz;
begin
  perform public.assert_it_system_admin(p_actor_user_id);
  if p_reason not in ('ROTATED', 'COMPROMISED', 'DECOMMISSIONED', 'INTEGRATION_DISABLED') then
    raise exception using errcode = '22023', message = 'Invalid credential revocation reason';
  end if;
  if p_grace_seconds is not null and p_grace_seconds not between 1 and 604800 then
    raise exception using errcode = '22023', message = 'Invalid credential grace period';
  end if;
  select * into existing from public.integration_credentials as credentials
  where credentials.id = p_credential_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Integration credential not found'; end if;
  perform pg_advisory_xact_lock(hashtextextended('sotoayam_integration_credential:' || existing.integration_id::text, 0));
  if existing.revoked_at is not null then updated := existing;
  elsif p_grace_seconds is not null then
    if existing.expires_at is not null and existing.expires_at <= now() then
      raise exception using errcode = '22023', message = 'Cannot apply grace to an expired integration credential';
    end if;
    requested_expiry := now() + make_interval(secs => p_grace_seconds);
    update public.integration_credentials as credentials
    set expires_at = case when existing.expires_at is null then requested_expiry
      else least(existing.expires_at, requested_expiry) end
    where credentials.id = p_credential_id returning * into updated;
    insert into public.audit_logs (actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source)
    values ('USER', p_actor_user_id, 'INTEGRATION_CREDENTIAL_GRACE_SET', 'INTEGRATION_CREDENTIAL', updated.id::text,
      jsonb_build_object('selector', existing.selector, 'integration_id', existing.integration_id, 'label', existing.label,
        'expires_at', existing.expires_at, 'reason', p_reason),
      jsonb_build_object('selector', updated.selector, 'integration_id', updated.integration_id, 'label', updated.label,
        'expires_at', updated.expires_at, 'reason', p_reason), 'integration_admin_api');
  else
    update public.integration_credentials as credentials
    set revoked_at = now(), revoked_by_user_id = p_actor_user_id, revoked_reason = p_reason
    where credentials.id = p_credential_id returning * into updated;
    insert into public.audit_logs (actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source)
    values ('USER', p_actor_user_id, 'INTEGRATION_CREDENTIAL_REVOKED', 'INTEGRATION_CREDENTIAL', updated.id::text,
      jsonb_build_object('selector', existing.selector, 'integration_id', existing.integration_id, 'label', existing.label,
        'revoked_at', existing.revoked_at, 'reason', existing.revoked_reason),
      jsonb_build_object('selector', updated.selector, 'integration_id', updated.integration_id, 'label', updated.label,
        'revoked_at', updated.revoked_at, 'reason', updated.revoked_reason), 'integration_admin_api');
  end if;
  if (select count(*) from public.integration_credentials as credentials
      where credentials.integration_id = existing.integration_id and credentials.revoked_at is null
        and (credentials.expires_at is null or credentials.expires_at > now())) > 2 then
    raise exception using errcode = 'P0001', message = 'At most two active integration credentials are allowed';
  end if;
  return query select updated.id, updated.integration_id, updated.selector, updated.label, updated.created_at,
    updated.created_by_user_id, updated.last_used_at, updated.expires_at, updated.revoked_at,
    updated.revoked_reason, updated.rotation_of_credential_id,
    case when updated.revoked_at is not null then 'REVOKED'
      when updated.expires_at is not null and updated.expires_at <= now() then 'EXPIRED' else 'ACTIVE' end::text;
end;
$$;

create or replace function public.revoke_integration_credentials_for_integration(
  p_integration_id bigint, p_reason text, p_actor_user_id bigint
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare affected integer; selectors jsonb;
begin
  perform public.assert_it_system_admin(p_actor_user_id);
  if p_reason not in ('ROTATED', 'COMPROMISED', 'DECOMMISSIONED', 'INTEGRATION_DISABLED') then
    raise exception using errcode = '22023', message = 'Invalid credential revocation reason';
  end if;
  select coalesce(jsonb_agg(credentials.selector order by credentials.id), '[]'::jsonb) into selectors
  from public.integration_credentials as credentials
  where credentials.integration_id = p_integration_id and credentials.revoked_at is null;
  update public.integration_credentials as credentials
  set revoked_at = now(), revoked_by_user_id = p_actor_user_id, revoked_reason = p_reason
  where credentials.integration_id = p_integration_id and credentials.revoked_at is null;
  get diagnostics affected = row_count;
  insert into public.audit_logs (actor_type, actor_user_id, action, object_type, object_id, after_state, source)
  values ('USER', p_actor_user_id, 'INTEGRATION_CREDENTIALS_PURGED', 'INTEGRATION_CREDENTIAL', p_integration_id::text,
    jsonb_build_object('integration_id', p_integration_id, 'selectors', selectors, 'reason', p_reason,
      'revoked_count', affected), 'integration_admin_api');
  return affected;
end;
$$;

create or replace function public.intake_attributed_notification_event(
  p_source text,
  p_external_event_id text,
  p_identity_origin text,
  p_event_type text,
  p_payload_hash text,
  p_message text,
  p_recipients jsonb,
  p_integration_id bigint
)
returns table (
  event_id bigint, created boolean, conflict boolean, recipient_count integer,
  routed_count integer, dispatched boolean, dispatch_sent integer, dispatch_failed integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare event_row record; recipient jsonb; normalized_user_id bigint; notification_id bigint;
  total_recipients integer := 0; total_routed integer := 0;
begin
  if p_source is null or p_source !~ '^[A-Z][A-Z0-9_]{0,49}$'
    or p_external_event_id is null or length(p_external_event_id) not between 1 and 200
    or p_external_event_id <> trim(p_external_event_id) or p_external_event_id ~ '[[:cntrl:]]'
    or p_identity_origin not in ('CALLER', 'GENERATED')
    or p_event_type not in ('STOCK_CRITICAL', 'PURCHASE_RECOMMENDATION', 'SALES_FOLLOWUP', 'MARKETING_ALERT',
      'CONTENT_OPPORTUNITY', 'OWNER_DAILY_REPORT', 'SYSTEM_ERROR')
    or p_payload_hash is null or length(p_payload_hash) <> 64
    or p_message is null or length(trim(p_message)) not between 1 and 4096
    or jsonb_typeof(p_recipients) <> 'array' or jsonb_array_length(p_recipients) > 500
    or not exists (select 1 from public.task_source_integrations where task_source_integrations.id = p_integration_id) then
    raise exception using errcode = '22023', message = 'Invalid notification event intake';
  end if;
  insert into public.notification_events (
    source, external_event_id, identity_origin, event_type, payload_hash, message, integration_id
  ) values (
    p_source, p_external_event_id, p_identity_origin, p_event_type, p_payload_hash, trim(p_message), p_integration_id
  )
  on conflict on constraint notification_events_identity_uidx do update set external_event_id = excluded.external_event_id
  returning notification_events.id, (xmax = 0) as inserted, notification_events.payload_hash,
    notification_events.recipient_count, notification_events.routed_count,
    notification_events.dispatched_at is not null as was_dispatched,
    notification_events.dispatch_sent, notification_events.dispatch_failed into event_row;
  if not event_row.inserted then
    return query select event_row.id, false, event_row.payload_hash <> p_payload_hash,
      event_row.recipient_count, event_row.routed_count, event_row.was_dispatched,
      event_row.dispatch_sent, event_row.dispatch_failed;
    return;
  end if;
  for recipient in select value from jsonb_array_elements(p_recipients) loop
    if jsonb_typeof(recipient) <> 'object' or (recipient->>'legacy_id') is null
      or (recipient->>'dedupe_key') is null or length(recipient->>'dedupe_key') <> 64 then
      raise exception using errcode = '22023', message = 'Invalid notification recipient expansion';
    end if;
    normalized_user_id := null;
    select normalized_user.id into normalized_user_id from public.users as normalized_user
    where normalized_user.legacy_telegram_user_id = (recipient->>'legacy_id')::bigint;
    insert into public.notifications (task_id, notification_event_id, event_type, recipient_user_id,
      routing_status, routing_failure_code, dedupe_key, message, occurrence_at)
    values (null, event_row.id, p_event_type, normalized_user_id,
      case when normalized_user_id is null then 'UNROUTED' else 'ROUTED' end,
      case when normalized_user_id is null then 'IDENTITY_UNMAPPED' else null end,
      recipient->>'dedupe_key', trim(p_message), now()) returning id into notification_id;
    total_recipients := total_recipients + 1;
    if normalized_user_id is not null then
      insert into public.notification_deliveries (notification_id, channel, state, scheduled_at, next_attempt_at)
      values (notification_id, 'TELEGRAM', 'PENDING', now(), now());
      total_routed := total_routed + 1;
    end if;
  end loop;
  update public.notification_events set recipient_count = total_recipients, routed_count = total_routed
  where notification_events.id = event_row.id;
  insert into public.audit_logs (actor_type, action, object_type, object_id, after_state, source)
  values ('SYSTEM', 'NOTIFICATION_EVENT_ACCEPTED', 'NOTIFICATION_EVENT', event_row.id::text,
    jsonb_build_object('source', p_source, 'event_type', p_event_type, 'identity_origin', p_identity_origin,
      'recipient_count', total_recipients, 'routed_count', total_routed, 'integration_id', p_integration_id),
    'notification_intake');
  return query select event_row.id, true, false, total_recipients, total_routed, false, 0, 0;
end;
$$;

revoke all on function public.authenticate_integration_credential(text, text, text) from public, anon, authenticated;
revoke all on function public.create_integration_credential(bigint, text, text, text, timestamptz, bigint, bigint) from public, anon, authenticated;
revoke all on function public.list_integration_credentials(bigint, bigint) from public, anon, authenticated;
revoke all on function public.revoke_integration_credential(bigint, text, integer, bigint) from public, anon, authenticated;
revoke all on function public.revoke_integration_credentials_for_integration(bigint, text, bigint) from public, anon, authenticated;
revoke all on function public.intake_attributed_notification_event(text, text, text, text, text, text, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.authenticate_integration_credential(text, text, text) to service_role;
grant execute on function public.create_integration_credential(bigint, text, text, text, timestamptz, bigint, bigint) to service_role;
grant execute on function public.list_integration_credentials(bigint, bigint) to service_role;
grant execute on function public.revoke_integration_credential(bigint, text, integer, bigint) to service_role;
grant execute on function public.revoke_integration_credentials_for_integration(bigint, text, bigint) to service_role;
grant execute on function public.intake_attributed_notification_event(text, text, text, text, text, text, jsonb, bigint) to service_role;

comment on table public.integration_credentials is
  'Per-integration machine credential metadata. Raw credentials are never persisted.';
comment on column public.integration_credentials.secret_hash is
  'Lowercase SHA-256 digest of a 256-bit random integration secret; never returned by application RPCs.';
comment on column public.notification_events.integration_id is
  'Authenticated integration attribution. Source remains INTERNAL_API for idempotency compatibility.';

commit;
