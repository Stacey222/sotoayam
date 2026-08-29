create table if not exists public.telegram_users (
  id bigint generated always as identity primary key,
  telegram_chat_id bigint not null unique,
  telegram_username text,
  telegram_first_name text,
  name text,
  division text not null default 'UNASSIGNED',
  role text not null default 'UNASSIGNED',
  active boolean not null default false,
  stock_alert boolean not null default false,
  purchase_alert boolean not null default false,
  sales_alert boolean not null default false,
  marketing_alert boolean not null default false,
  content_alert boolean not null default false,
  owner_report boolean not null default false,
  system_error boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists telegram_users_active_idx on public.telegram_users (active);
create index if not exists telegram_users_division_idx on public.telegram_users (division);

create or replace function public.set_telegram_users_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_telegram_users_updated_at on public.telegram_users;
create trigger set_telegram_users_updated_at
before update on public.telegram_users
for each row execute function public.set_telegram_users_updated_at();

alter table public.telegram_users enable row level security;

comment on table public.telegram_users is
  'Telegram registrations and notification routing preferences. Accessed by the backend service role only.';
