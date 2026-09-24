begin;

-- OWNER retains its business-oversight permissions while gaining the MVP task
-- workflow. SYSTEM_ADMIN remains an independent user authority assignment.
insert into public.role_permissions (role_id, permission_id)
select roles.id, permissions.id from public.roles roles
join public.permissions permissions on permissions.code in (
  'task.view_assigned', 'task.create', 'task.update_assigned',
  'task.complete_assigned', 'task.add_activity', 'task.view_division'
)
where roles.code = 'OWNER'
on conflict (role_id, permission_id) do nothing;

commit;
