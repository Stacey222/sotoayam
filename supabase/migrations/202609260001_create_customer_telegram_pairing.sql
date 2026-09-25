begin;

create table public.telegram_pairing_tokens (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  user_id bigint not null references public.users(id) on delete cascade,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);
create index telegram_pairing_tokens_user_id_idx on public.telegram_pairing_tokens(user_id);
alter table public.telegram_pairing_tokens enable row level security;
revoke all on table public.telegram_pairing_tokens from public, anon, authenticated, service_role;

alter table public.user_channels
  add column notification_preferences_reviewed_at timestamptz;
create unique index user_channels_one_active_type_per_user_idx
  on public.user_channels(user_id, channel_type) where active;

create function public.create_telegram_pairing(
  p_user_id bigint, p_token_hash text, p_expires_at timestamptz
) returns table(expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  if p_user_id is null or p_token_hash !~ '^[0-9a-f]{64}$'
    or p_expires_at <= now() or p_expires_at > now() + interval '15 minutes' then
    raise exception using errcode='22023', message='INVALID_TELEGRAM_PAIRING';
  end if;
  if not exists(select 1 from public.users where id=p_user_id and active) then
    raise exception using errcode='22023', message='TELEGRAM_PAIRING_USER_UNAVAILABLE';
  end if;
  if exists(select 1 from public.user_channels where user_id=p_user_id and channel_type='TELEGRAM' and active) then
    raise exception using errcode='23505', message='TELEGRAM_ALREADY_CONNECTED';
  end if;
  delete from public.telegram_pairing_tokens where user_id=p_user_id and consumed_at is null;
  insert into public.telegram_pairing_tokens(token_hash,user_id,expires_at)
  values(lower(p_token_hash),p_user_id,p_expires_at);
  return query select p_expires_at;
end;
$$;

create function public.consume_telegram_pairing(
  p_token_hash text, p_telegram_chat_id bigint, p_telegram_username text, p_telegram_first_name text
) returns setof public.telegram_users
language plpgsql security definer set search_path = '' as $$
declare
  pairing public.telegram_pairing_tokens%rowtype;
  target public.users%rowtype;
  legacy public.telegram_users%rowtype;
  division_name text;
  role_code text;
begin
  if p_token_hash !~ '^[0-9a-f]{64}$' or p_telegram_chat_id is null then
    raise exception using errcode='22023', message='TELEGRAM_PAIRING_INVALID_OR_EXPIRED';
  end if;
  select * into pairing from public.telegram_pairing_tokens
    where token_hash=lower(p_token_hash) for update;
  if not found or pairing.consumed_at is not null or pairing.expires_at <= now() then
    raise exception using errcode='22023', message='TELEGRAM_PAIRING_INVALID_OR_EXPIRED';
  end if;
  select u.* into target from public.users u where u.id=pairing.user_id and u.active for update;
  if not found then raise exception using errcode='22023', message='TELEGRAM_PAIRING_USER_UNAVAILABLE'; end if;
  if target.legacy_telegram_user_id is not null
    or exists(select 1 from public.user_channels where user_id=target.id and channel_type='TELEGRAM' and active) then
    raise exception using errcode='23505', message='TELEGRAM_ALREADY_CONNECTED';
  end if;
  if exists(select 1 from public.user_channels where channel_type='TELEGRAM' and external_id=p_telegram_chat_id::text)
    or exists(select 1 from public.telegram_users where telegram_chat_id=p_telegram_chat_id) then
    raise exception using errcode='23505', message='TELEGRAM_IDENTITY_ALREADY_CONNECTED';
  end if;
  select d.name, r.code into division_name, role_code
    from public.divisions d, public.roles r where d.id=target.division_id and r.id=target.role_id;
  insert into public.telegram_users(telegram_chat_id,telegram_username,telegram_first_name,name,division,role,active)
    values(p_telegram_chat_id,nullif(trim(p_telegram_username),''),nullif(trim(p_telegram_first_name),''),
      target.display_name,coalesce(division_name,'UNASSIGNED'),
      case role_code when 'OWNER' then 'Owner' when 'ADMIN' then 'Admin' else 'Staff' end,true)
    returning * into legacy;
  update public.users set legacy_telegram_user_id=legacy.id where id=target.id;
  insert into public.user_channels(user_id,channel_type,external_id,username,active,verified_at)
    values(target.id,'TELEGRAM',p_telegram_chat_id::text,nullif(trim(p_telegram_username),''),true,now());
  update public.telegram_pairing_tokens set consumed_at=now() where token_hash=pairing.token_hash;
  insert into public.audit_logs(actor_type,actor_user_id,action,object_type,object_id,after_state,source)
    values('USER',target.id,'TELEGRAM_CHANNEL_CONNECTED','USER',target.id::text,
      jsonb_build_object('channel_type','TELEGRAM','verified',true),'telegram_pairing');
  return next legacy;
end;
$$;

create function public.update_own_telegram_preferences(
  p_user_id bigint, p_stock boolean, p_purchase boolean, p_sales boolean,
  p_marketing boolean, p_content boolean, p_owner_report boolean, p_system_error boolean
) returns table(notification_type text, enabled boolean)
language plpgsql security definer set search_path = '' as $$
declare legacy_id bigint;
begin
  select legacy_telegram_user_id into legacy_id from public.users where id=p_user_id and active for update;
  if legacy_id is null then raise exception using errcode='22023', message='TELEGRAM_NOT_CONNECTED'; end if;
  update public.telegram_users set stock_alert=p_stock,purchase_alert=p_purchase,sales_alert=p_sales,
    marketing_alert=p_marketing,content_alert=p_content,owner_report=p_owner_report,system_error=p_system_error
    where id=legacy_id;
  update public.user_channels set notification_preferences_reviewed_at=now()
    where user_id=p_user_id and channel_type='TELEGRAM' and active;
  insert into public.audit_logs(actor_type,actor_user_id,action,object_type,object_id,after_state,source)
    values('USER',p_user_id,'NOTIFICATION_PREFERENCES_UPDATED','USER',p_user_id::text,
      jsonb_build_object('reviewed',true),'customer_telegram_settings');
  return query select p.notification_type,p.enabled from public.telegram_notification_preferences p
    where p.telegram_user_id=legacy_id order by p.notification_type;
end;
$$;

revoke all on function public.create_telegram_pairing(bigint,text,timestamptz) from public,anon,authenticated,service_role;
revoke all on function public.consume_telegram_pairing(text,bigint,text,text) from public,anon,authenticated,service_role;
revoke all on function public.update_own_telegram_preferences(bigint,boolean,boolean,boolean,boolean,boolean,boolean,boolean) from public,anon,authenticated,service_role;
grant execute on function public.create_telegram_pairing(bigint,text,timestamptz) to service_role;
grant execute on function public.consume_telegram_pairing(text,bigint,text,text) to service_role;
grant execute on function public.update_own_telegram_preferences(bigint,boolean,boolean,boolean,boolean,boolean,boolean,boolean) to service_role;

commit;
