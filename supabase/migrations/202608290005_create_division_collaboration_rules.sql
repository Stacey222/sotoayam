begin;

create table public.division_collaboration_rules (
  id bigint generated always as identity primary key,
  source_division_id bigint not null references public.divisions (id),
  target_division_id bigint not null references public.divisions (id),
  task_scope text not null default 'ALL' check (task_scope = 'ALL'),
  allowed boolean not null default false,
  requires_approval boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (source_division_id <> target_division_id),
  check (allowed or not requires_approval)
);

create unique index division_collaboration_rules_active_unique
  on public.division_collaboration_rules (source_division_id, target_division_id, task_scope)
  where active;
create index division_collaboration_rules_target_idx
  on public.division_collaboration_rules (target_division_id) where active;

create trigger set_division_collaboration_rules_updated_at
before update on public.division_collaboration_rules
for each row execute function public.set_governance_updated_at();

alter table public.division_collaboration_rules enable row level security;
revoke all on table public.division_collaboration_rules from public, anon, authenticated;

with seeded as (
  insert into public.division_collaboration_rules (
    source_division_id, target_division_id, task_scope, allowed, requires_approval, active
  )
  select source.id, target.id, 'ALL', true, false, true
  from public.divisions source
  cross join public.divisions target
  where source.code = 'ONPAGE_B2C' and target.code = 'CONTENT_CREATOR'
  on conflict (source_division_id, target_division_id, task_scope) where active do nothing
  returning id, source_division_id, target_division_id
)
insert into public.audit_logs (
  actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source
)
select 'SYSTEM', null, 'COLLABORATION_RULE_CREATED', 'DIVISION_COLLABORATION_RULE', id::text, null,
  jsonb_build_object(
    'source_division_id', source_division_id,
    'target_division_id', target_division_id,
    'task_scope', 'ALL',
    'allowed', true,
    'requires_approval', false,
    'active', true
  ),
  'migration_seed'
from seeded;

comment on table public.division_collaboration_rules is
  'Directional, default-deny Cross-Divisi task collaboration policy. Missing active relation means denied.';

commit;
