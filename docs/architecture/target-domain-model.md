# Target Domain Model

## Design rules

- Preserve the working `telegram_users` path until a verified cutover.
- Add normalized tables; do not reinterpret legacy strings in place.
- A person is not a Telegram channel, a role, or a notification route.
- Authorization combines explicit permission, Divisi scope, and—only for governance operations—system authority.
- ERP and other providers remain sources of truth. Store references, operational state, justified snapshots, and freshness—not speculative replicas.
- Use stable machine codes and editable display names. Renaming a Divisi must not rewrite historical foreign keys.
- Append audit/history records rather than hiding material state transitions in one mutable row.

## Recommended now: people and governance foundation

### `divisions`

Core fields: `id`, immutable unique `code`, editable `name`, `active`, timestamps.

Why: confirmed dynamic create/rename/activate/disable requirement. A stable key is required by users, tasks, routes, reports, alerts, and collaboration rules. It cannot safely remain a repeated string.

Initial seed codes: `PURCHASING`, `SALES_GROSIR`, `DIGITAL_MARKETING`, `CONTENT_CREATOR`, `ONPAGE_B2C`, `SHOPEE_LIVE`, `GUDANG`, `MANAGEMENT`, `IT`. Seeds are configuration, not hard-coded business logic.

### `users`

Core fields: `id`, `name`, `home_division_id`, `active`, timestamps. New/inactive registrations may have a null home Divisi; activation must require one.

Why: the person must survive channel replacement and must be referenced by task, audit, authority, and reporting domains. `telegram_users` cannot remain the universal identity record.

### `user_channels`

Core fields: `id`, `user_id`, `channel_type`, `external_id`, provider username/display metadata, `active`, timestamps; unique `(channel_type, external_id)`.

Why: Telegram Chat ID belongs to a communication channel. Separating it permits future channel changes without duplicating roles/tasks. Store `external_id` as text to avoid provider-specific numeric assumptions.

### `roles`, `permissions`, `role_permissions`, `user_roles`

- `roles`: stable code, editable name, active state; creating a row grants nothing.
- `permissions`: stable capability codes such as `TASK_CREATE`, `TASK_UPDATE_ASSIGNED`, `USER_MANAGE`, `ROUTING_MANAGE`.
- `role_permissions`: explicit many-to-many grants.
- `user_roles`: auditable assignment history with active/revoked timestamps and assigning actor; enforce at most one active business Role per user.

Why: roles must be extensible without implicit privilege. The assignment table preserves handover/history while a partial unique invariant enforces the confirmed one-active-business-Role rule. It avoids encoding permission meaning into names such as `ADMIN`.

Legacy `PIC`, `SUPERVISOR`, and `MANAGER` values must be preserved during migration as zero-permission legacy roles until IT reviews them; they must never be silently mapped to `ADMIN`.

### `system_authority_assignments`

Core fields: `id`, `user_id`, `authority_code`, `granted_by`, `granted_at`, `revoked_by`, `revoked_at`, optional reason; one active assignment per `(user_id, authority_code)`.

Why: `SYSTEM_ADMIN` is a transferable, auditable governance authority, not a business role. Grant/revoke must be transactional and audited. It does not automatically grant OWNER business visibility.

### `audit_logs`

Core fields: `id`, `actor_user_id` nullable for trusted system actors, `action`, `object_type`, `object_id`, sanitized `before_state`/`after_state` JSON, `source`, `request_id`, `occurred_at`.

Why: configuration, authority, task, and routing changes must answer WHO/WHAT/OBJECT/WHEN and often before/after. This cross-cutting append-only record cannot live in each mutable entity.

## Recommended when task core begins

### `tasks`

Core fields:

- identity/title/description;
- `status`: `DRAFT`, `OPEN`, `IN_PROGRESS`, `BLOCKED`, `COMPLETED`, `CANCELLED`;
- `priority`, `deadline`, `completed_at`;
- `created_by_user_id`, nullable `assigned_to_user_id`;
- `requesting_division_id`, `owner_division_id`;
- `source_type`: `MANUAL`, `CSV_IMPORT`, `AUTOMATION`, `ERP`, `AI_ASSISTED`;
- trace references appropriate to the source;
- timestamps and optimistic concurrency version.

`OVERDUE` is a query/projection: deadline is past and status is not terminal. It is not stored as the primary status.

Why: confirmed operational work has its own lifecycle and two distinct Divisi responsibilities. Do not combine requester and executor into one field.

### `task_activities`

Core fields: `task_id`, actor, activity type, comment/note, status transition fields, evidence URL/file reference, sanitized metadata, timestamp.

Why: comments, evidence, completion information, and status history are repeatable events. Adding one column per update to `tasks` would lose history and become unbounded.

### `task_relationships`

Store canonical directions only: `PARENT_OF`, `BLOCKS`, `RELATED_TO`; derive `CHILD_OF` and `BLOCKED_BY`. Fields include source task, target task, type, creator, timestamp; reject self-links and duplicates.

Why: separate tasks retain their own Divisi ownership while dependencies remain explicit. A single giant cross-Divisi task would blur accountability.

### `task_import_batches`

Core fields: creator, source file reference/checksum, requesting Divisi, status, row counts, timestamps, error summary.

Why: `CSV_IMPORT` requires batch traceability, preview, retry, and troubleshooting. Do not store raw spreadsheets indefinitely by default. A per-row staging table should be added only when the import implementation proves it necessary.

### `division_collaboration_rules`

Core fields: source Divisi, target Divisi, `scope_code`, decision (`ALLOW`/`DENY`), `requires_approval`, active state, effective dates, changed actor; unique active rule per source/target/scope.

Why: cross-Divisi task creation is required but cannot be unrestricted. Rules are IT-controlled configuration and need auditability. Default behavior is deny when no active allow rule matches.

### `task_approvals` (defer until an approval-required rule is implemented)

Core fields: task, requested actor/time, required approver scope, status, decided actor/time, reason.

Why: approval is a stateful decision with an actor and timestamp. Do not overload task status or collaboration rule configuration with a specific approval instance.

## Recommended for event, notification, and alert migration

### `automation_events`

Core fields: unique external `event_id`, source, event type, occurred/received timestamps, sanitized payload/metadata, processing status, provider/internal error codes.

Why: current `event_id` is not persisted. Durable events provide idempotency, troubleshooting, source traceability, and a stable parent for alerts/deliveries.

### `notification_event_types` and `notification_routes`

- Event types define a stable code, category (business/technical), allowed delivery modes, and active state.
- Routes match event type plus optional severity, Divisi, role, or specific user; define mandatory state, delivery mode (`PUSH`, `SCHEDULED`, `ON_DEMAND`), active/effective dates.

Why: routing is IT-controlled and contextual. User-table booleans cannot represent mandatory notifications, severity, role, or scoped routes. Route validation must reject ambiguous routes and require at least one target selector.

### `notification_deliveries`

Core fields: event/alert, route, user/channel, attempt, status, provider code, internal code, sent/failed timestamps, retry reference. Do not store secrets or unsafe provider payloads.

Why: logs cannot support delivery auditing, retry state, or monitoring.

### `alert_policies`

Core fields: code, source/event type, scope, active state, severity configuration, relative deviation, absolute/material floor, baseline rule, duration/persistence, cooldown, aggregation window, strategic override, schema version, changed actor.

Why: confirmed alert dimensions vary by business signal. A versioned validated configuration is more appropriate than universal hard-coded thresholds. JSON configuration is acceptable for policy-specific parameters only when validated by policy type; identity, state, scope, and timestamps remain relational columns.

### `alert_instances` and `alert_acknowledgements`

- Instance: policy/event, fingerprint, severity, status (`OPEN`, `ACKNOWLEDGED`, `RESOLVED`), first/last seen, occurrence count, impact summary, escalation state.
- Acknowledgement: alert, actor, action/time, note.

Why: fingerprint/state enables dedupe, cooldown, aggregation, and escalation. Acknowledgements are auditable actions, not a boolean preference.

## Defer until its first executable capability

### `report_catalog`

Appropriate when the first dynamic report is built. Suggested fields: code, name, required permission, supported Divisi/source, handler capability key, freshness policy, active state. It should select registered code capabilities, not arbitrary SQL from configuration.

Reason to defer: no report provider or executable report exists today. Creating rows now would be speculative; the authorization/freshness contract should be designed with the first real report.

### `integration_health` and `incidents`

Add with the technical monitoring slice. Health stores current/periodic integration status and freshness; incidents store lifecycle, impact, affected Divisi, provider/internal codes, and resolution.

Reason to defer: current integrations expose no normalized health events. Logs remain the temporary source.

### Error-code catalog table

Defer. Begin with typed code conventions in source (`DB-*`, `TLG-*`, etc.) and separate provider/internal fields in event/delivery/incident records. A database catalog is justified only if codes become user-configurable or need localization.

## Relationships overview

```text
divisions 1---* users *---1 active business role (assignment history) ---* roles *---* permissions
                    |
                    +---* user_channels
                    +---* system_authority_assignments
                    +---* tasks (creator/assignee)

divisions 1---* tasks (requesting and owner)
divisions *---* divisions through collaboration_rules
tasks 1---* task_activities
tasks *---* tasks through task_relationships

automation_events 1---* alert_instances 1---* acknowledgements
automation_events/alerts 1---* notification_deliveries
notification_routes ---> event type + target Divisi/role/user

audit_logs ---> changes across all governed objects
```

## Legacy-field disposition

| Legacy field | Target | Disposition |
|---|---|---|
| Telegram identity fields | `user_channels` | Dual-write, verify, then read normalized. |
| `name`, `active` | `users` | Backfill and reconcile. |
| `division` | `users.home_division_id` | Map through stable Divisi code; keep legacy during transition. |
| `role` | `user_roles` | Map reviewed codes; unknown/legacy roles grant zero permissions. |
| Seven alert booleans | `notification_routes` | Translate only after IT approves route semantics; retain until parity. |
| `telegram_users.id` | compatibility bridge | Add nullable unique normalized `user_id` during migration; remove only at final decommission. |
