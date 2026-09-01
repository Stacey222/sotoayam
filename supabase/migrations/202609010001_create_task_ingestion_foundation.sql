begin;

create table public.task_source_integrations (
  id bigint generated always as identity primary key,
  code text not null unique check (code ~ '^[A-Z][A-Z0-9_]*$'),
  name text not null check (length(trim(name)) between 1 and 200),
  source text not null check (source in ('AUTOMATION', 'ERP')),
  requesting_division_id bigint not null references public.divisions (id),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.task_import_batches (
  id bigint generated always as identity primary key,
  context text not null check (context in ('HUMAN_IMPORT', 'INTERNAL_AUTOMATION', 'ERP_ADAPTER')),
  source text not null check (source in ('CSV_IMPORT', 'AUTOMATION', 'ERP')),
  initiated_by_user_id bigint references public.users (id),
  integration_id bigint references public.task_source_integrations (id),
  safe_label text check (safe_label is null or length(trim(safe_label)) between 1 and 200),
  dry_run boolean not null default false,
  status text not null default 'PROCESSING' check (status in ('PROCESSING', 'COMPLETED', 'PARTIAL', 'FAILED')),
  total_rows integer not null default 0 check (total_rows between 0 and 500),
  created_rows integer not null default 0 check (created_rows between 0 and total_rows),
  failed_rows integer not null default 0 check (failed_rows between 0 and total_rows),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  check (
    (context = 'HUMAN_IMPORT' and source = 'CSV_IMPORT' and initiated_by_user_id is not null and integration_id is null)
    or (context = 'INTERNAL_AUTOMATION' and source = 'AUTOMATION' and initiated_by_user_id is null and integration_id is not null)
    or (context = 'ERP_ADAPTER' and source = 'ERP' and initiated_by_user_id is null and integration_id is not null)
  )
);

alter table public.tasks
  alter column created_by_user_id drop not null,
  add column integration_id bigint references public.task_source_integrations (id),
  add column import_batch_id bigint references public.task_import_batches (id),
  add constraint tasks_exactly_one_origin_check check (
    (created_by_user_id is not null and integration_id is null)
    or (created_by_user_id is null and integration_id is not null)
  );

create unique index tasks_human_external_reference_uidx
  on public.tasks (source, created_by_user_id, source_reference)
  where source_reference is not null and created_by_user_id is not null;

create unique index tasks_integration_external_reference_uidx
  on public.tasks (source, integration_id, source_reference)
  where source_reference is not null and integration_id is not null;

create index task_source_integrations_requesting_division_idx
  on public.task_source_integrations (requesting_division_id);
create index task_import_batches_initiated_by_user_idx
  on public.task_import_batches (initiated_by_user_id) where initiated_by_user_id is not null;
create index task_import_batches_integration_idx
  on public.task_import_batches (integration_id) where integration_id is not null;
create index tasks_integration_id_idx on public.tasks (integration_id) where integration_id is not null;
create index tasks_import_batch_id_idx on public.tasks (import_batch_id) where import_batch_id is not null;

create trigger set_task_source_integrations_updated_at
before update on public.task_source_integrations
for each row execute function public.set_governance_updated_at();

alter table public.task_source_integrations enable row level security;
alter table public.task_import_batches enable row level security;

comment on table public.task_source_integrations is
  'Trusted server-side task origins. Credentials are never stored in this table.';
comment on table public.task_import_batches is
  'Bounded task ingestion metadata only; CSV contents and client filesystem paths are never retained.';

commit;
