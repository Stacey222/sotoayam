begin;

create table public.telegram_polling_state (
  singleton_key text primary key default 'TELEGRAM_POLLING'
    check (singleton_key = 'TELEGRAM_POLLING'),
  next_offset bigint not null default 0 check (next_offset >= 0),
  last_pruned_at timestamptz,
  updated_at timestamptz not null default now()
);

create table public.telegram_processed_updates (
  update_id bigint primary key check (update_id >= 0),
  status text not null check (status in ('PROCESSING', 'COMPLETED', 'FAILED')),
  attempt_count integer not null default 1 check (attempt_count between 1 and 100),
  update_type text not null check (update_type in ('message', 'callback_query', 'other')),
  failure_class text check (failure_class is null or length(failure_class) between 1 and 100),
  received_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  check ((status = 'PROCESSING' and completed_at is null)
    or (status <> 'PROCESSING' and completed_at is not null)),
  check (status <> 'COMPLETED' or failure_class is null)
);

create index telegram_processed_updates_prune_idx
  on public.telegram_processed_updates (completed_at)
  where status <> 'PROCESSING';

create trigger set_telegram_polling_state_updated_at
before update on public.telegram_polling_state
for each row execute function public.set_governance_updated_at();

create trigger set_telegram_processed_updates_updated_at
before update on public.telegram_processed_updates
for each row execute function public.set_governance_updated_at();

insert into public.telegram_polling_state (singleton_key) values ('TELEGRAM_POLLING');

alter table public.telegram_polling_state enable row level security;
alter table public.telegram_processed_updates enable row level security;
revoke all on table public.telegram_polling_state from public, anon, authenticated, service_role;
revoke all on table public.telegram_processed_updates from public, anon, authenticated, service_role;

create function public.load_telegram_polling_state()
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select next_offset
  from public.telegram_polling_state
  where singleton_key = 'TELEGRAM_POLLING'
$$;

create function public.claim_telegram_update(
  p_update_id bigint,
  p_update_type text,
  p_max_attempts integer
)
returns table (action text, attempt_count integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted boolean := false;
  existing public.telegram_processed_updates%rowtype;
  next_attempt integer;
begin
  if p_update_id is null or p_update_id < 0
    or p_update_type not in ('message', 'callback_query', 'other')
    or p_max_attempts not between 1 and 10 then
    raise exception using errcode = '22023', message = 'Invalid Telegram update claim';
  end if;

  insert into public.telegram_processed_updates (update_id, status, update_type)
  values (p_update_id, 'PROCESSING', p_update_type)
  on conflict (update_id) do nothing
  returning true into inserted;

  if coalesce(inserted, false) then
    return query select 'PROCESS'::text, 1;
    return;
  end if;

  select * into existing
  from public.telegram_processed_updates as updates
  where updates.update_id = p_update_id
  for update;

  if existing.status <> 'PROCESSING' then
    return query select 'SKIP_DUPLICATE'::text, existing.attempt_count;
    return;
  end if;

  next_attempt := existing.attempt_count + 1;
  if next_attempt > p_max_attempts then
    update public.telegram_processed_updates as updates
    set status = 'FAILED', attempt_count = next_attempt,
      failure_class = 'ATTEMPTS_EXHAUSTED', completed_at = now()
    where updates.update_id = p_update_id;
    return query select 'SKIP_EXHAUSTED'::text, next_attempt;
    return;
  end if;

  update public.telegram_processed_updates as updates
  set attempt_count = next_attempt
  where updates.update_id = p_update_id;
  return query select 'PROCESS'::text, next_attempt;
end;
$$;

create function public.complete_telegram_update(
  p_update_id bigint,
  p_status text,
  p_failure_class text,
  p_retention_days integer default 7
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  blocking bigint;
  candidate bigint;
  result bigint;
  prune_due boolean;
begin
  if p_update_id is null or p_update_id < 0
    or p_status not in ('COMPLETED', 'FAILED')
    or (p_status = 'COMPLETED' and p_failure_class is not null)
    or (p_status = 'FAILED' and (p_failure_class is null or length(p_failure_class) not between 1 and 100))
    or p_retention_days not between 1 and 90 then
    raise exception using errcode = '22023', message = 'Invalid Telegram update completion';
  end if;

  update public.telegram_processed_updates as updates
  set status = p_status, failure_class = p_failure_class, completed_at = now()
  where updates.update_id = p_update_id and updates.status = 'PROCESSING';

  if not found and not exists (
    select 1 from public.telegram_processed_updates as updates
    where updates.update_id = p_update_id and updates.status <> 'PROCESSING'
  ) then
    raise exception using errcode = 'P0002', message = 'Telegram update claim not found';
  end if;

  select min(updates.update_id) into blocking
  from public.telegram_processed_updates as updates
  where updates.status = 'PROCESSING';

  candidate := p_update_id + 1;
  if blocking is not null then candidate := least(candidate, blocking); end if;

  update public.telegram_polling_state as polling
  set next_offset = greatest(polling.next_offset, candidate)
  where polling.singleton_key = 'TELEGRAM_POLLING'
  returning polling.next_offset,
    polling.last_pruned_at is null or polling.last_pruned_at <= now() - interval '1 hour'
  into result, prune_due;

  if result is null then
    raise exception using errcode = 'P0002', message = 'Telegram polling state not found';
  end if;

  if prune_due then
    delete from public.telegram_processed_updates as updates
    where updates.status <> 'PROCESSING'
      and updates.completed_at < now() - make_interval(days => p_retention_days)
      and updates.update_id < result;
    update public.telegram_polling_state as polling
    set last_pruned_at = now()
    where polling.singleton_key = 'TELEGRAM_POLLING';
  end if;

  return result;
end;
$$;

create function public.force_advance_telegram_offset(
  p_next_offset bigint,
  p_reason text,
  p_actor_user_id bigint
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  previous_offset bigint;
begin
  perform public.assert_it_system_admin(p_actor_user_id);
  if p_next_offset is null or p_next_offset < 0
    or p_reason is null or length(trim(p_reason)) not between 1 and 500 then
    raise exception using errcode = '22023', message = 'Invalid Telegram offset recovery request';
  end if;

  select polling.next_offset into previous_offset
  from public.telegram_polling_state as polling
  where polling.singleton_key = 'TELEGRAM_POLLING'
  for update;

  if previous_offset is null then
    raise exception using errcode = 'P0002', message = 'Telegram polling state not found';
  end if;
  if p_next_offset <= previous_offset then
    raise exception using errcode = '22023', message = 'Telegram offset must move forward';
  end if;

  update public.telegram_polling_state as polling
  set next_offset = p_next_offset
  where polling.singleton_key = 'TELEGRAM_POLLING';

  insert into public.audit_logs
    (actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source)
  values ('USER', p_actor_user_id, 'TELEGRAM_OFFSET_FORCE_ADVANCED', 'TELEGRAM_POLLING_STATE',
    'TELEGRAM_POLLING', jsonb_build_object('next_offset', previous_offset),
    jsonb_build_object('next_offset', p_next_offset, 'reason', trim(p_reason)), 'telegram_offset_recovery');

  return p_next_offset;
end;
$$;

revoke all on function public.load_telegram_polling_state() from public, anon, authenticated;
revoke all on function public.claim_telegram_update(bigint, text, integer) from public, anon, authenticated;
revoke all on function public.complete_telegram_update(bigint, text, text, integer) from public, anon, authenticated;
revoke all on function public.force_advance_telegram_offset(bigint, text, bigint) from public, anon, authenticated;
grant execute on function public.load_telegram_polling_state() to service_role;
grant execute on function public.claim_telegram_update(bigint, text, integer) to service_role;
grant execute on function public.complete_telegram_update(bigint, text, text, integer) to service_role;
grant execute on function public.force_advance_telegram_offset(bigint, text, bigint) to service_role;

commit;
