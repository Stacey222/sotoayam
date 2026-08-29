begin;

create table if not exists public.users (
  id bigint generated always as identity primary key,
  display_name text check (display_name is null or length(trim(display_name)) > 0),
  division_id bigint references public.divisions (id),
  role_id bigint references public.roles (id),
  active boolean not null default false,
  legacy_telegram_user_id bigint unique references public.telegram_users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not active or (division_id is not null and role_id is not null))
);

create table if not exists public.user_channels (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.users (id),
  channel_type text not null check (channel_type in ('TELEGRAM')),
  external_id text not null check (length(trim(external_id)) > 0),
  username text,
  active boolean not null default true,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel_type, external_id)
);

create index if not exists users_division_id_idx on public.users (division_id);
create index if not exists users_role_id_idx on public.users (role_id);
create index if not exists users_active_idx on public.users (active);
create index if not exists user_channels_user_id_idx on public.user_channels (user_id);
create index if not exists user_channels_active_idx on public.user_channels (active);

drop trigger if exists set_users_updated_at on public.users;
create trigger set_users_updated_at
before update on public.users
for each row execute function public.set_governance_updated_at();

drop trigger if exists set_user_channels_updated_at on public.user_channels;
create trigger set_user_channels_updated_at
before update on public.user_channels
for each row execute function public.set_governance_updated_at();

alter table public.users enable row level security;
alter table public.user_channels enable row level security;

do $$
begin
  if exists (
    select 1 from public.telegram_users
    where division <> 'UNASSIGNED'
      and division not in (
        'Purchasing', 'Sales Grosir', 'Digital Marketing', 'Content Creator',
        'On Page / B2C', 'Live Shopee', 'Shopee Live', 'Gudang', 'Management', 'IT'
      )
  ) then
    raise exception 'Unsupported legacy division mapping';
  end if;

  if exists (
    select 1 from public.telegram_users
    where role <> 'UNASSIGNED' and role not in ('Staff', 'Admin', 'Owner')
  ) then
    raise exception 'Unsupported legacy role mapping';
  end if;

  if exists (
    select telegram_chat_id from public.telegram_users
    group by telegram_chat_id having count(*) > 1
  ) then
    raise exception 'Duplicate legacy Telegram identity';
  end if;

  if exists (
    select 1 from public.telegram_users
    where active and (division = 'UNASSIGNED' or role = 'UNASSIGNED')
  ) then
    raise exception 'Active legacy user has incomplete business assignment';
  end if;
end;
$$;

with mapped as (
  select
    tu.*,
    case tu.division
      when 'Purchasing' then 'PURCHASING'
      when 'Sales Grosir' then 'SALES_GROSIR'
      when 'Digital Marketing' then 'DIGITAL_MARKETING'
      when 'Content Creator' then 'CONTENT_CREATOR'
      when 'On Page / B2C' then 'ONPAGE_B2C'
      when 'Live Shopee' then 'SHOPEE_LIVE'
      when 'Shopee Live' then 'SHOPEE_LIVE'
      when 'Gudang' then 'GUDANG'
      when 'Management' then 'MANAGEMENT'
      when 'IT' then 'IT'
    end as division_code,
    case tu.role
      when 'Staff' then 'STAFF'
      when 'Admin' then 'ADMIN'
      when 'Owner' then 'OWNER'
    end as role_code
  from public.telegram_users tu
)
insert into public.users (
  display_name, division_id, role_id, active, legacy_telegram_user_id, created_at, updated_at
)
select
  coalesce(nullif(trim(mapped.name), ''), nullif(trim(mapped.telegram_first_name), '')),
  divisions.id,
  roles.id,
  mapped.active,
  mapped.id,
  mapped.created_at,
  mapped.updated_at
from mapped
left join public.divisions on divisions.code = mapped.division_code
left join public.roles on roles.code = mapped.role_code
on conflict (legacy_telegram_user_id) do update set
  display_name = excluded.display_name,
  division_id = excluded.division_id,
  role_id = excluded.role_id,
  active = excluded.active,
  updated_at = excluded.updated_at;

insert into public.user_channels (
  user_id, channel_type, external_id, username, active, verified_at, created_at, updated_at
)
select
  users.id,
  'TELEGRAM',
  telegram_users.telegram_chat_id::text,
  telegram_users.telegram_username,
  true,
  telegram_users.created_at,
  telegram_users.created_at,
  telegram_users.updated_at
from public.telegram_users
join public.users on users.legacy_telegram_user_id = telegram_users.id
on conflict (channel_type, external_id) do update set
  username = excluded.username,
  updated_at = excluded.updated_at;

insert into public.audit_logs (
  actor_type, action, object_type, object_id, before_state, after_state, source
)
select
  'SYSTEM', 'USER_BACKFILLED', 'USER', users.id::text, null,
  jsonb_build_object('active', users.active, 'legacy_mapping', true),
  'slice_2_backfill'
from public.users
where users.legacy_telegram_user_id is not null
  and not exists (
    select 1 from public.audit_logs
    where action = 'USER_BACKFILLED' and object_type = 'USER' and object_id = users.id::text
  );

insert into public.audit_logs (
  actor_type, action, object_type, object_id, before_state, after_state, source
)
select
  'SYSTEM', 'CHANNEL_LINKED', 'USER_CHANNEL', user_channels.id::text, null,
  jsonb_build_object('channel_type', user_channels.channel_type, 'active', user_channels.active),
  'slice_2_backfill'
from public.user_channels
where user_channels.channel_type = 'TELEGRAM'
  and not exists (
    select 1 from public.audit_logs
    where action = 'CHANNEL_LINKED' and object_type = 'USER_CHANNEL' and object_id = user_channels.id::text
  );

alter table public.system_authority_assignments
  add constraint system_authority_assignments_user_id_fkey
  foreign key (user_id) references public.users (id) not valid;
alter table public.system_authority_assignments
  add constraint system_authority_assignments_granted_by_user_id_fkey
  foreign key (granted_by_user_id) references public.users (id) not valid;
alter table public.system_authority_assignments
  add constraint system_authority_assignments_revoked_by_user_id_fkey
  foreign key (revoked_by_user_id) references public.users (id) not valid;
alter table public.audit_logs
  add constraint audit_logs_actor_user_id_fkey
  foreign key (actor_user_id) references public.users (id) not valid;

alter table public.system_authority_assignments validate constraint system_authority_assignments_user_id_fkey;
alter table public.system_authority_assignments validate constraint system_authority_assignments_granted_by_user_id_fkey;
alter table public.system_authority_assignments validate constraint system_authority_assignments_revoked_by_user_id_fkey;
alter table public.audit_logs validate constraint audit_logs_actor_user_id_fkey;

create or replace function public.register_telegram_identity(
  p_telegram_chat_id bigint,
  p_telegram_username text,
  p_telegram_first_name text
)
returns setof public.telegram_users
language plpgsql
security definer
set search_path = ''
as $$
declare
  legacy_row public.telegram_users%rowtype;
  normalized_user_id bigint;
  normalized_division_id bigint;
  normalized_role_id bigint;
  channel_id bigint;
  channel_user_id bigint;
  user_was_missing boolean;
  channel_was_missing boolean;
begin
  insert into public.telegram_users (
    telegram_chat_id, telegram_username, telegram_first_name
  ) values (
    p_telegram_chat_id, p_telegram_username, p_telegram_first_name
  )
  on conflict (telegram_chat_id) do update set
    telegram_username = excluded.telegram_username,
    telegram_first_name = excluded.telegram_first_name
  returning * into legacy_row;

  select divisions.id into normalized_division_id
  from public.divisions
  where divisions.code = case legacy_row.division
    when 'Purchasing' then 'PURCHASING'
    when 'Sales Grosir' then 'SALES_GROSIR'
    when 'Digital Marketing' then 'DIGITAL_MARKETING'
    when 'Content Creator' then 'CONTENT_CREATOR'
    when 'On Page / B2C' then 'ONPAGE_B2C'
    when 'Live Shopee' then 'SHOPEE_LIVE'
    when 'Shopee Live' then 'SHOPEE_LIVE'
    when 'Gudang' then 'GUDANG'
    when 'Management' then 'MANAGEMENT'
    when 'IT' then 'IT'
  end;

  select roles.id into normalized_role_id
  from public.roles
  where roles.code = case legacy_row.role
    when 'Staff' then 'STAFF'
    when 'Admin' then 'ADMIN'
    when 'Owner' then 'OWNER'
  end;

  if legacy_row.division <> 'UNASSIGNED' and normalized_division_id is null then
    raise exception 'Unsupported legacy division mapping';
  end if;
  if legacy_row.role <> 'UNASSIGNED' and normalized_role_id is null then
    raise exception 'Unsupported legacy role mapping';
  end if;

  user_was_missing := not exists (
    select 1 from public.users where legacy_telegram_user_id = legacy_row.id
  );

  insert into public.users (
    display_name, division_id, role_id, active, legacy_telegram_user_id,
    created_at, updated_at
  ) values (
    coalesce(nullif(trim(legacy_row.name), ''), nullif(trim(legacy_row.telegram_first_name), '')),
    normalized_division_id,
    normalized_role_id,
    legacy_row.active,
    legacy_row.id,
    legacy_row.created_at,
    legacy_row.updated_at
  )
  on conflict (legacy_telegram_user_id) do update set
    display_name = coalesce(users.display_name, excluded.display_name)
  returning id into normalized_user_id;

  channel_was_missing := not exists (
    select 1 from public.user_channels
    where channel_type = 'TELEGRAM' and external_id = p_telegram_chat_id::text
  );

  insert into public.user_channels (
    user_id, channel_type, external_id, username, active, verified_at
  ) values (
    normalized_user_id, 'TELEGRAM', p_telegram_chat_id::text,
    p_telegram_username, true, now()
  )
  on conflict (channel_type, external_id) do update set
    username = excluded.username,
    verified_at = coalesce(user_channels.verified_at, excluded.verified_at)
  returning id, user_id into channel_id, channel_user_id;

  if channel_user_id <> normalized_user_id then
    raise exception 'Telegram identity is linked to another normalized user';
  end if;

  if user_was_missing then
    insert into public.audit_logs (
      actor_type, action, object_type, object_id, before_state, after_state, source
    ) values (
      'SYSTEM', 'USER_CREATED', 'USER', normalized_user_id::text, null,
      jsonb_build_object('active', legacy_row.active, 'onboarding', not legacy_row.active),
      'telegram_registration'
    );
  end if;

  if channel_was_missing then
    insert into public.audit_logs (
      actor_type, action, object_type, object_id, before_state, after_state, source
    ) values (
      'SYSTEM', 'CHANNEL_LINKED', 'USER_CHANNEL', channel_id::text, null,
      jsonb_build_object('channel_type', 'TELEGRAM', 'active', true),
      'telegram_registration'
    );
  end if;

  return next legacy_row;
  return;
end;
$$;

revoke all on function public.register_telegram_identity(bigint, text, text) from public;
revoke all on function public.register_telegram_identity(bigint, text, text) from anon;
revoke all on function public.register_telegram_identity(bigint, text, text) from authenticated;
grant execute on function public.register_telegram_identity(bigint, text, text) to service_role;

comment on table public.users is
  'Normalized human identity. division_id and role_id remain nullable during pending IT authorization. legacy_telegram_user_id is a transitional reconciliation bridge.';
comment on table public.user_channels is
  'Communication identities belonging to normalized users. Channel metadata never grants business authority.';
comment on function public.register_telegram_identity(bigint, text, text) is
  'Server-only atomic compatibility write for legacy Telegram registration and normalized identity synchronization.';

commit;
