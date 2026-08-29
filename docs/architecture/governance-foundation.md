# Governance Foundation (Slice 1)

## Scope and compatibility boundary

Slice 1 adds server-only governance storage and repository boundaries. It does not wire the new catalogs into routes, Telegram registration, the Admin UI/API, or notification routing. `telegram_users` remains authoritative for all current behavior, including its legacy `division` and `role` text values.

The migration is local-only until the live Supabase migration registry can be verified authoritatively. All new tables have RLS enabled and no public policies. They are intended to be accessed only by trusted server-side code with application authorization.

## Divisi model

`divisions` uses an immutable, unique uppercase `code` as the business key and an editable `name` for display. `active = false` removes a Divisi from future selection without invalidating historical references. The nine initial codes are seeded with `ON CONFLICT (code) DO NOTHING`, so a rerun neither duplicates rows nor overwrites an operator-edited display name.

The repository accepts any syntactically valid database code; the nine seeds are not an application enum. Runtime migration from legacy division strings is intentionally deferred.

## Business roles and permissions

`roles` stores the dynamic business roles `STAFF`, `ADMIN`, and `OWNER`. `permissions` stores explicit capabilities. `role_permissions` maps catalogs by stable identifiers and has a composite primary key, making grants repeatable.

Each normalized user will eventually have exactly one active business role. Slice 1 creates only the catalogs and grant map; user-to-role assignment waits for normalized identity in Slice 2.

Initial grants:

- STAFF: `task.view_assigned`, `task.create`, `task.update_assigned`, `task.complete_assigned`, `task.add_activity`, `task.import`.
- ADMIN: all STAFF grants plus `task.view_division`, `report.view_division`, `alert.view_division`.
- OWNER: `report.view_cross_division`, `alert.view_critical`, `approval.view`, `approval.decide`, `automation_status.view_business`.

Governance permissions are deliberately not granted to ADMIN. OWNER does not receive `technical_monitoring.view` and is not a technical superuser. The catalogs contain governance capabilities for a later authorization slice, but Slice 1 does not grant them to a business role.

## SYSTEM_ADMIN authority and transfer

`system_authority_assignments` is separate from `roles`. It stores `SYSTEM_ADMIN`, a future normalized `user_id`, grant/revoke timestamps, actors, and an optional bounded reason. It never stores or depends on a Telegram chat ID. No authority assignment is seeded because normalized users do not exist yet.

The future handover operation must be one audited database transaction:

1. verify the current active SYSTEM_ADMIN and the receiving normalized user;
2. create the receiver's assignment;
3. revoke the previous assignment;
4. write audit entries;
5. commit only if at least one active SYSTEM_ADMIN remains.

Slice 1 enforces only one active assignment per user and authority. The foreign keys to normalized users and the invariant preventing zero active SYSTEM_ADMIN are deferred to Slice 2, where they can be implemented without orphan identifiers or legacy coupling. Until then, the repository is read-only and no live assignment is allowed.

## Audit model

`audit_logs` records actor type/user, action, object type/id, sanitized before/after state, source, and creation time. A database trigger rejects UPDATE and DELETE, making records append-only even for privileged application access.

The audit repository recursively redacts secret-bearing keys and recognizable credential values, rejects unsupported/circular/overly deep state, and caps serialized state at 32 KiB. Raw request bodies, headers, cookies, authorization values, tokens, passwords, service keys, Telegram credentials, and arbitrary large payloads are forbidden. Audit state must be a purposeful object containing only fields needed to explain the governance change.

## Intentionally not implemented

- normalized `users` or `user_channels`;
- legacy user, Divisi, or role backfill;
- user-to-role assignment;
- live SYSTEM_ADMIN assignment or transfer endpoint;
- task, approval, Owner Console, or technical monitoring features;
- notification-routing normalization;
- runtime read/write cutover from `telegram_users`;
- any public RLS policy or frontend service-role access.
