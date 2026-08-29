# Incremental Database Migration Plan

## Non-negotiable compatibility gates

Throughout migration, these must remain green:

```text
Telegram /start -> registration -> persistence -> reply
Admin UI list/edit
POST /api/notifications/send recipient parity
npm run check:supabase
```

No phase drops or renames a legacy field. Every SQL change is a new forward migration. Each phase is independently deployable, observable, and reversible at the application level.

## Phase 0 — Baseline and deployment discipline

**Migration:** none. Record migration checksums, live row counts (aggregated only), distinct legacy Divisi/Role values, duplicate/null anomalies, current indexes/constraints/RLS, and a restore point using approved Supabase backup facilities.

**Application change:** add no behavior. Establish CI commands and a read-only migration preflight report. Keep `check:supabase` unchanged.

**Compatibility risk:** low; diagnostic write must continue exact cleanup.

**Rollback:** none required because no persistent change.

**Verification:** current checks pass; `/start` before/after snapshot; confirm no diagnostic rows remain.

## Phase 1 — Add governance reference data

**Migration:** create additive `divisions`, `roles`, `permissions`, `role_permissions`, `user_roles`, `system_authority_assignments`, and `audit_logs`. Seed nine Divisi codes and reviewed baseline role/permission codes. RLS enabled with no public write policy. Add indexes for active lookups and foreign keys.

**Application change:** introduce repositories/services behind unused feature flags; legacy reads/writes remain authoritative. Build an authorization decision service with deny-by-default tests, but do not attach it to current routes yet.

**Compatibility risk:** seed mapping mistakes and accidental permission grants. New roles must have zero permissions until explicit grants are applied.

**Rollback:** disable feature flag and leave additive tables unused. Do not drop tables in emergency rollback; a later reviewed migration may remove them if truly unused.

**Verification:** seed codes unique; disabled Divisi rejected by new service; creating an empty role grants no capability; authority grant/revoke produces audit entries.

## Phase 2 — Normalize identity in shadow mode

**Migration:** create `users` and `user_channels`. Add nullable unique `user_id` FK to `telegram_users` as a compatibility bridge. Backfill idempotently:

- one `users` row per legacy row;
- map known Divisi display strings to stable codes;
- map known roles; preserve `PIC`, `SUPERVISOR`, and `MANAGER` as reviewed legacy roles with no implicit permission;
- one TELEGRAM channel per unique Chat ID;
- leave unassigned inactive users with null home Divisi/role assignment;
- set bridge `telegram_users.user_id`.

**Application change:** add a normalization reconciliation command that reports counts/mismatches without identifiers. Current repository remains authoritative.

**Compatibility risk:** inconsistent legacy spelling, partial backfill, channel collision, and unsafe role mapping.

**Rollback:** stop backfill/reconciliation; legacy table is unchanged and fully operational. Additive normalized rows may remain dormant.

**Verification:** one-to-one bridge counts, no duplicate channel external ID, every active legacy user maps to active user + home Divisi, and `/start` remains unchanged.

## Phase 3 — Dual-write Telegram registration

**Migration:** preferably add a database function/transaction that atomically upserts legacy Telegram metadata and normalized channel/user bridge. Do not expose it publicly. Alternatively use a server transaction-capable database adapter; avoid two independent HTTP writes without repair logic.

**Application change:** create an `IdentityRepository` interface. `/start` calls a compatibility implementation that preserves legacy upsert first and mirrors normalized state. Registration success remains contingent on the authoritative legacy write until parity is proven.

**Compatibility risk:** split-brain if only one side writes, changes to reply timing, or duplicate user/channel creation under concurrent `/start`.

**Rollback:** feature flag returns `/start` to existing `TelegramUsersRepository`; bridge data remains for reconciliation.

**Verification:** concurrent and repeated `/start`; no duplicates; legacy admin fields and normalized role assignments unchanged; failure injection proves repair/retry path.

## Phase 4 — Identity-aware administration and dynamic catalogs

**Migration:** add audit constraints/indexes and any required invite/activation state. Do not drop legacy Divisi/Role strings.

**Application change:** replace hard-coded browser/server Divisi and Role lists with catalog endpoints. Introduce authenticated admin identity. Enforce `IT home Divisi + permission`; protect permission/system-authority changes with `SYSTEM_ADMIN`. Admin writes normalized entities and mirrors compatibility fields while old UI/API consumers remain supported.

**Compatibility risk:** locking out the only administrator, shared-key fallback becoming permanent, or differing normalized/legacy values.

**Rollback:** retain a tightly controlled, time-limited bootstrap path and feature flag back to legacy Admin API. Never expose service-role credentials to the browser.

**Verification:** ADMIN from a business Divisi receives 403 for user management; IT with permission succeeds; every change has actor/before/after audit; dynamic rename changes display without rewriting references.

## Phase 5 — Switch identity reads, retain compatibility writes

**Migration:** add indexes/constraints only after reconciliation: active users require home Divisi and reviewed role policy as appropriate. Keep `telegram_users` and bridge.

**Application change:** Admin API and new authorization read normalized users/channels. A compatibility DTO still returns the current `TelegramUser` response shape. `/start` normalized write becomes authoritative only after parity metrics remain clean; legacy metadata continues mirrored.

**Compatibility risk:** response-shape regression in Admin UI and recipient resolution.

**Rollback:** feature flag returns reads to legacy repository; no normalized data is deleted.

**Verification:** contract snapshots for `/api/users`, same filters/status, Admin UI regression, `/start`, and reconciliation at zero mismatch.

## Phase 6 — Task core and collaboration

**Migration:** add `tasks`, `task_activities`, `task_relationships`, `division_collaboration_rules`; add `task_approvals` only with the first approval-required workflow. Later add `task_import_batches` with import implementation.

**Application change:** task services enforce permission + scope + rule; transactional activity/audit; no Telegram wizard or UI until REST/domain behavior is proven.

**Compatibility risk:** unauthorized cross-Divisi access, ambiguous ownership, invalid status transitions.

**Rollback:** disable task routes/features. Tables are isolated from registration/notification paths.

**Verification:** same-Divisi allowed, cross rule allow/deny/approval, requesting visibility, owner execution, lifecycle invariants, overdue projection, audit.

## Phase 7 — Normalize events and notification routing

**Migration:** add `automation_events`, `notification_event_types`, `notification_routes`, and `notification_deliveries`. Seed equivalents of existing seven event mappings as inactive/draft routes first.

**Application change:** accept current endpoint contract, persist/dedupe `event_id`, resolve both legacy and normalized recipients in comparison mode, but deliver through legacy result only. IT reviews recipient diffs. Then switch delivery to normalized routes behind a flag.

**Compatibility risk:** missed or duplicated notifications, treating optional legacy preference as mandatory, OWNER over-notification.

**Rollback:** route delivery back to legacy boolean resolver. Keep event/delivery history; never replay automatically without idempotency review.

**Verification:** recipient parity fixtures, mandatory route behavior, division/role/user targeting, inactive users, delivery isolation, event dedupe, no duplicate Telegram sends.

## Phase 8 — Alert and monitoring capabilities

**Migration:** add `alert_policies`, `alert_instances`, `alert_acknowledgements`; add integration health/incidents only with real monitoring producers.

**Application change:** policy evaluators implement validated policy types, material floors, baseline, duration, dedupe/cooldown, aggregation, escalation, and acknowledgement. Separate business summaries from technical incidents.

**Compatibility risk:** alert storms, stale inputs presented as current, invalid policy configuration, escalation after acknowledgement.

**Rollback:** deactivate new policies/routes and use existing notification endpoint; retain incident/audit history.

**Verification:** deterministic policy fixtures, aggregation volumes, fingerprint dedupe, cooldown, acknowledgement stops escalation, freshness labels.

## Phase 9 — Legacy deprecation (not currently authorized)

Only begin after at least one agreed observation window with:

- normalized identity reconciliation at zero mismatch;
- all current consumers migrated;
- route parity approved by IT;
- tested restore procedure;
- no legacy writes in logs/metrics.

First mark boolean preferences and legacy identity columns deprecated. Stop writes, then retain read-only compatibility view/table for a defined period. Dropping `telegram_users` or its columns requires a separate destructive migration approval and is explicitly outside the current plan execution.

## Compatibility details

### Telegram `/start`

- Preserve exact reply and metadata semantics.
- Use unique `(channel_type, external_id)` plus the legacy unique Chat ID.
- Repeat registration refreshes only provider metadata.
- Never reset user Divisi, roles, activation, permissions, routes, or task data.

### Admin UI/API

- Keep `/api/users` response shape during early migration via DTO mapping.
- Add catalog endpoints before removing hard-coded dropdowns.
- Migrate authentication before enabling sensitive governance endpoints.
- Keep browser isolated from Supabase server credentials.

### Notification endpoint

- Preserve event type/message/metadata input and response counts.
- Persist `event_id` without changing delivery behavior first.
- Compare recipient sets before switching resolver.
- Keep a rollback flag to legacy booleans until parity is approved.

### Supabase diagnostic

- Continue verifying the legacy table until `/start` no longer depends on it.
- Add normalized table checks only as additive output after corresponding migrations.
- Every synthetic write must preflight uniqueness and clean up exact ID+marker in `finally`.

## Data migration rules

1. Backfills are idempotent and keyed by stable bridge/unique constraints.
2. Never infer permission from a legacy role name beyond explicitly approved mapping.
3. Unknown Divisi/Role values go to a remediation report, not a guessed target.
4. Backfill scripts report aggregate counts, not Chat IDs or personal data.
5. Use transactions for relational state that must remain consistent.
6. Add `NOT NULL`/FK/check constraints only after backfill and validation.
7. Each application switch has a feature flag and old read path until acceptance.
