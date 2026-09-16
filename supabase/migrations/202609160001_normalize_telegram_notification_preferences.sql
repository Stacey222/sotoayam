begin;

create table public.telegram_notification_preferences (
  telegram_user_id bigint not null references public.telegram_users(id) on delete cascade,
  notification_type text not null check (notification_type in (
    'STOCK_CRITICAL', 'PURCHASE_RECOMMENDATION', 'SALES_FOLLOWUP',
    'MARKETING_ALERT', 'CONTENT_OPPORTUNITY', 'OWNER_DAILY_REPORT', 'SYSTEM_ERROR'
  )),
  enabled boolean not null default false,
  primary key (telegram_user_id, notification_type)
);
create index telegram_notification_preferences_enabled_type_idx
  on public.telegram_notification_preferences (notification_type, telegram_user_id) where enabled;
alter table public.telegram_notification_preferences enable row level security;
revoke all on table public.telegram_notification_preferences from public, anon, authenticated, service_role;
grant select on table public.telegram_notification_preferences to service_role;

create function public.mirror_telegram_notification_preferences()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.telegram_notification_preferences (telegram_user_id, notification_type, enabled)
  values
    (new.id, 'STOCK_CRITICAL', new.stock_alert),
    (new.id, 'PURCHASE_RECOMMENDATION', new.purchase_alert),
    (new.id, 'SALES_FOLLOWUP', new.sales_alert),
    (new.id, 'MARKETING_ALERT', new.marketing_alert),
    (new.id, 'CONTENT_OPPORTUNITY', new.content_alert),
    (new.id, 'OWNER_DAILY_REPORT', new.owner_report),
    (new.id, 'SYSTEM_ERROR', new.system_error)
  on conflict (telegram_user_id, notification_type) do update set enabled = excluded.enabled
    where public.telegram_notification_preferences.enabled is distinct from excluded.enabled;
  return new;
end;
$$;
revoke all on function public.mirror_telegram_notification_preferences() from public, anon, authenticated, service_role;

-- CREATE TRIGGER holds a table lock until commit, closing the concurrent-write gap
-- between the backfill snapshot and activation of mirroring on existing rows.
create trigger mirror_telegram_notification_preferences_insert
after insert on public.telegram_users for each row
execute function public.mirror_telegram_notification_preferences();
create trigger mirror_telegram_notification_preferences_update
after update of stock_alert, purchase_alert, sales_alert, marketing_alert,
  content_alert, owner_report, system_error on public.telegram_users for each row
execute function public.mirror_telegram_notification_preferences();

insert into public.telegram_notification_preferences (telegram_user_id, notification_type, enabled)
select tu.id, preference.notification_type, preference.enabled
from public.telegram_users tu
cross join lateral (values
  ('STOCK_CRITICAL', tu.stock_alert),
  ('PURCHASE_RECOMMENDATION', tu.purchase_alert),
  ('SALES_FOLLOWUP', tu.sales_alert),
  ('MARKETING_ALERT', tu.marketing_alert),
  ('CONTENT_OPPORTUNITY', tu.content_alert),
  ('OWNER_DAILY_REPORT', tu.owner_report),
  ('SYSTEM_ERROR', tu.system_error)
) preference(notification_type, enabled)
on conflict (telegram_user_id, notification_type) do update set enabled = excluded.enabled
  where public.telegram_notification_preferences.enabled is distinct from excluded.enabled;

create function public.find_shadow_notification_recipients(p_notification_type text)
returns setof public.telegram_users
language plpgsql security definer set search_path = '' as $$
begin
  if p_notification_type is null or p_notification_type not in (
    'STOCK_CRITICAL', 'PURCHASE_RECOMMENDATION', 'SALES_FOLLOWUP',
    'MARKETING_ALERT', 'CONTENT_OPPORTUNITY', 'OWNER_DAILY_REPORT', 'SYSTEM_ERROR'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_NOTIFICATION_TYPE';
  end if;
  return query
    select tu.* from public.telegram_users tu
    where tu.active and exists (
      select 1 from public.telegram_notification_preferences preference
      where preference.telegram_user_id = tu.id
        and preference.notification_type = p_notification_type
        and preference.enabled
    );
end;
$$;
revoke all on function public.find_shadow_notification_recipients(text) from public, anon, authenticated, service_role;
grant execute on function public.find_shadow_notification_recipients(text) to service_role;

commit;
