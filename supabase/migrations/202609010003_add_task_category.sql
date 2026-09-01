begin;

alter table public.tasks
  add column task_category text
    check (task_category is null or task_category ~ '^[A-Z][A-Z0-9_]{0,49}$');

create index tasks_reporting_category_idx
  on public.tasks (owner_division_id, task_category, created_at desc)
  where task_category is not null;

comment on column public.tasks.task_category is
  'Canonical optional business category assigned through TaskService/intake; never inferred from free text.';

commit;
