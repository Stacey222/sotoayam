begin;

create table public.tasks (
  id bigint generated always as identity primary key,
  title text not null check (length(trim(title)) between 1 and 200),
  description text check (description is null or length(description) <= 10000),
  status text not null default 'DRAFT'
    check (status in ('DRAFT', 'OPEN', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED', 'CANCELLED')),
  priority text not null default 'NORMAL'
    check (priority in ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  source text not null default 'MANUAL'
    check (source in ('MANUAL', 'CSV_IMPORT', 'AUTOMATION', 'ERP', 'AI_ASSISTED')),
  source_reference text check (source_reference is null or length(trim(source_reference)) between 1 and 500),
  created_by_user_id bigint not null references public.users (id),
  requesting_division_id bigint not null references public.divisions (id),
  owner_division_id bigint not null references public.divisions (id),
  assigned_to_user_id bigint references public.users (id),
  deadline timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'COMPLETED') = (completed_at is not null)),
  check ((status = 'CANCELLED') = (cancelled_at is not null)),
  check (completed_at is null or cancelled_at is null)
);

create table public.task_activities (
  id bigint generated always as identity primary key,
  task_id bigint not null references public.tasks (id),
  actor_user_id bigint not null references public.users (id),
  activity_type text not null
    check (activity_type in ('COMMENT', 'STATUS_CHANGE', 'EVIDENCE', 'ASSIGNMENT_CHANGE')),
  note text check (note is null or length(trim(note)) between 1 and 10000),
  visibility text not null default 'SHARED'
    check (visibility in ('SHARED', 'INTERNAL')),
  evidence_type text not null default 'NONE'
    check (evidence_type in ('NONE', 'URL', 'FILE_REFERENCE', 'TEXT')),
  evidence_reference text check (evidence_reference is null or length(trim(evidence_reference)) between 1 and 5000),
  created_at timestamptz not null default now(),
  check (
    (evidence_type = 'NONE' and evidence_reference is null)
    or (evidence_type <> 'NONE' and evidence_reference is not null)
  ),
  check (evidence_type <> 'URL' or evidence_reference ~* '^https?://')
);

create table public.task_relationships (
  id bigint generated always as identity primary key,
  source_task_id bigint not null references public.tasks (id),
  target_task_id bigint not null references public.tasks (id),
  relationship_type text not null
    check (relationship_type in ('PARENT_OF', 'CHILD_OF', 'BLOCKS', 'BLOCKED_BY', 'RELATED_TO')),
  created_by_user_id bigint not null references public.users (id),
  created_at timestamptz not null default now(),
  check (source_task_id <> target_task_id),
  unique (source_task_id, target_task_id, relationship_type)
);

create or replace function public.prevent_task_activity_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'task_activities is append-only';
end;
$$;

create index tasks_created_by_user_id_idx on public.tasks (created_by_user_id);
create index tasks_requesting_division_id_idx on public.tasks (requesting_division_id);
create index tasks_owner_division_id_idx on public.tasks (owner_division_id);
create index tasks_assigned_to_user_id_idx on public.tasks (assigned_to_user_id);
create index tasks_status_idx on public.tasks (status);
create index tasks_priority_idx on public.tasks (priority);
create index tasks_deadline_idx on public.tasks (deadline) where deadline is not null;
create index task_activities_task_id_created_at_idx on public.task_activities (task_id, created_at);
create index task_relationships_target_task_id_idx on public.task_relationships (target_task_id);

create trigger set_tasks_updated_at
before update on public.tasks
for each row execute function public.set_governance_updated_at();

create trigger prevent_task_activity_update_or_delete
before update or delete on public.task_activities
for each row execute function public.prevent_task_activity_mutation();

alter table public.tasks enable row level security;
alter table public.task_activities enable row level security;
alter table public.task_relationships enable row level security;

comment on table public.tasks is
  'Canonical Task Core records. OVERDUE is derived from deadline and terminal status, never stored.';
comment on table public.task_activities is
  'Append-oriented operational task history, notes, and lightweight evidence references.';
comment on table public.task_relationships is
  'Directed bounded task relationships without automatic reciprocal rows or workflow propagation.';

commit;
