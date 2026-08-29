begin;

create or replace function public.set_governance_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.divisions (
  id bigint generated always as identity primary key,
  code text not null unique check (code ~ '^[A-Z][A-Z0-9_]*$'),
  name text not null check (length(trim(name)) > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.roles (
  id bigint generated always as identity primary key,
  code text not null unique check (code ~ '^[A-Z][A-Z0-9_]*$'),
  name text not null check (length(trim(name)) > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.permissions (
  id bigint generated always as identity primary key,
  code text not null unique check (code ~ '^[a-z][a-z0-9_.]*$'),
  name text not null check (length(trim(name)) > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.role_permissions (
  role_id bigint not null references public.roles (id),
  permission_id bigint not null references public.permissions (id),
  created_at timestamptz not null default now(),
  primary key (role_id, permission_id)
);

create table if not exists public.system_authority_assignments (
  id bigint generated always as identity primary key,
  user_id bigint not null,
  authority_code text not null default 'SYSTEM_ADMIN'
    check (authority_code = 'SYSTEM_ADMIN'),
  granted_at timestamptz not null default now(),
  granted_by_user_id bigint,
  revoked_at timestamptz,
  revoked_by_user_id bigint,
  reason text check (reason is null or length(reason) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (revoked_at is null or revoked_at >= granted_at)
);

create unique index if not exists system_authority_one_active_assignment_idx
  on public.system_authority_assignments (user_id, authority_code)
  where revoked_at is null;

create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  actor_type text not null check (actor_type in ('USER', 'SYSTEM')),
  actor_user_id bigint,
  action text not null check (length(trim(action)) > 0),
  object_type text not null check (length(trim(object_type)) > 0),
  object_id text not null check (length(trim(object_id)) > 0),
  before_state jsonb check (before_state is null or jsonb_typeof(before_state) = 'object'),
  after_state jsonb check (after_state is null or jsonb_typeof(after_state) = 'object'),
  source text not null check (length(trim(source)) > 0),
  created_at timestamptz not null default now(),
  check (actor_type <> 'USER' or actor_user_id is not null)
);

create or replace function public.prevent_audit_log_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_logs is append-only';
end;
$$;

drop trigger if exists set_divisions_updated_at on public.divisions;
create trigger set_divisions_updated_at
before update on public.divisions
for each row execute function public.set_governance_updated_at();

drop trigger if exists set_roles_updated_at on public.roles;
create trigger set_roles_updated_at
before update on public.roles
for each row execute function public.set_governance_updated_at();

drop trigger if exists set_permissions_updated_at on public.permissions;
create trigger set_permissions_updated_at
before update on public.permissions
for each row execute function public.set_governance_updated_at();

drop trigger if exists set_system_authority_assignments_updated_at on public.system_authority_assignments;
create trigger set_system_authority_assignments_updated_at
before update on public.system_authority_assignments
for each row execute function public.set_governance_updated_at();

drop trigger if exists prevent_audit_log_update_or_delete on public.audit_logs;
create trigger prevent_audit_log_update_or_delete
before update or delete on public.audit_logs
for each row execute function public.prevent_audit_log_mutation();

alter table public.divisions enable row level security;
alter table public.roles enable row level security;
alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;
alter table public.system_authority_assignments enable row level security;
alter table public.audit_logs enable row level security;

insert into public.divisions (code, name)
values
  ('PURCHASING', 'Purchasing'),
  ('SALES_GROSIR', 'Sales Grosir'),
  ('DIGITAL_MARKETING', 'Digital Marketing'),
  ('CONTENT_CREATOR', 'Content Creator'),
  ('ONPAGE_B2C', 'On Page / B2C'),
  ('SHOPEE_LIVE', 'Shopee Live'),
  ('GUDANG', 'Gudang'),
  ('MANAGEMENT', 'Management'),
  ('IT', 'IT')
on conflict (code) do nothing;

insert into public.roles (code, name)
values
  ('STAFF', 'Staff'),
  ('ADMIN', 'Admin'),
  ('OWNER', 'Owner')
on conflict (code) do nothing;

insert into public.permissions (code, name)
values
  ('task.view_assigned', 'View assigned tasks'),
  ('task.create', 'Create tasks'),
  ('task.update_assigned', 'Update assigned tasks'),
  ('task.complete_assigned', 'Complete assigned tasks'),
  ('task.add_activity', 'Add task activity'),
  ('task.import', 'Import tasks'),
  ('task.view_division', 'View division tasks'),
  ('report.view_division', 'View division reports'),
  ('alert.view_division', 'View division alerts'),
  ('report.view_cross_division', 'View cross-division reports'),
  ('alert.view_critical', 'View critical alerts'),
  ('approval.view', 'View approvals'),
  ('approval.decide', 'Decide approvals'),
  ('automation_status.view_business', 'View business automation status'),
  ('user.manage', 'Manage users'),
  ('division.manage', 'Manage divisions'),
  ('role.manage', 'Manage roles'),
  ('permission.manage', 'Manage permissions'),
  ('routing.manage', 'Manage routing'),
  ('threshold.manage', 'Manage thresholds'),
  ('collaboration_rule.manage', 'Manage collaboration rules'),
  ('system_authority.manage', 'Manage system authority'),
  ('technical_monitoring.view', 'View technical monitoring')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select role_catalog.id, permission_catalog.id
from public.roles as role_catalog
join public.permissions as permission_catalog on permission_catalog.code in (
  'task.view_assigned',
  'task.create',
  'task.update_assigned',
  'task.complete_assigned',
  'task.add_activity',
  'task.import'
)
where role_catalog.code = 'STAFF'
on conflict (role_id, permission_id) do nothing;

insert into public.role_permissions (role_id, permission_id)
select role_catalog.id, permission_catalog.id
from public.roles as role_catalog
join public.permissions as permission_catalog on permission_catalog.code in (
  'task.view_assigned',
  'task.create',
  'task.update_assigned',
  'task.complete_assigned',
  'task.add_activity',
  'task.import',
  'task.view_division',
  'report.view_division',
  'alert.view_division'
)
where role_catalog.code = 'ADMIN'
on conflict (role_id, permission_id) do nothing;

insert into public.role_permissions (role_id, permission_id)
select role_catalog.id, permission_catalog.id
from public.roles as role_catalog
join public.permissions as permission_catalog on permission_catalog.code in (
  'report.view_cross_division',
  'alert.view_critical',
  'approval.view',
  'approval.decide',
  'automation_status.view_business'
)
where role_catalog.code = 'OWNER'
on conflict (role_id, permission_id) do nothing;

comment on table public.divisions is 'Dynamic business division catalog; server-only in Slice 1.';
comment on table public.roles is 'Dynamic business role catalog; server-only in Slice 1.';
comment on table public.permissions is 'Explicit capability catalog; server-only in Slice 1.';
comment on table public.role_permissions is 'Business role capability grants; server-only in Slice 1.';
comment on table public.system_authority_assignments is
  'SYSTEM_ADMIN authority history. user_id foreign keys and the nonzero-active invariant are deferred until normalized users exist.';
comment on table public.audit_logs is
  'Append-only sanitized governance audit records. Raw request bodies and credentials are forbidden.';

commit;
