begin;

alter table public.telegram_users
  add column if not exists division text;

update public.telegram_users
set division = 'UNASSIGNED'
where division is null;

alter table public.telegram_users
  alter column division set default 'UNASSIGNED',
  alter column division set not null;

create index if not exists telegram_users_division_idx
  on public.telegram_users (division);

commit;
