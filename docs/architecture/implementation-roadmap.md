# Implementation Roadmap

Each slice is deliberately bounded. A slice is complete only when its acceptance criteria and rollback boundary are demonstrated. Later slices must not be pulled into earlier work.

## Slice 0 — Migration baseline and contract harness

- **Goal:** make current behavior measurable before schema expansion.
- **Components:** migration preflight/reconciliation scripts, API contract fixtures, Telegram registration regression tests, deployment checklist.
- **Database impact:** none; read-only inventory plus existing reversible diagnostic.
- **Tests:** `/start` concurrent/repeated behavior, `/api/users` response snapshots, current recipient sets, migration-file checksum checks.
- **Acceptance:** current checks green; live migration state and legacy distinct values recorded safely; no production row output.
- **Dependencies:** none.
- **Rollback boundary:** documentation/scripts only; remove unused harness without runtime impact.

## Slice 1 — Divisi and governance foundation

- **Goal:** add dynamic Divisi, roles, permissions, system authority, and audit without changing current routes.
- **Components:** new migrations, domain types, repositories, authorization decision service, seed script, tests.
- **Database impact:** additive reference/governance tables with RLS and indexes.
- **Tests:** role-without-permission denies, Divisi lifecycle, authority transfer rules, append-only audit, no public access.
- **Acceptance:** tables/seeds validated; existing `/start`, Admin UI/API, notifications, and diagnostic unchanged.
- **Dependencies:** Slice 0 baseline.
- **Rollback boundary:** feature-disabled additive tables; legacy remains authoritative.

## Slice 2 — Identity normalization and reconciliation

- **Goal:** create users/channels and idempotently map legacy Telegram rows.
- **Components:** `users`, `user_channels`, compatibility bridge migration, backfill/reconciliation command.
- **Database impact:** additive tables plus nullable `telegram_users.user_id`.
- **Tests:** mapping variants, unknown values, no duplicate channels, aggregate parity, rerunnable backfill.
- **Acceptance:** every valid legacy row has exactly one bridge; zero unexplained mismatch; no changed legacy behavior.
- **Dependencies:** Slice 1 Divisi/roles.
- **Rollback boundary:** stop reconciliation and ignore normalized tables.

## Slice 3 — Telegram dual-write compatibility

- **Goal:** mirror `/start` into normalized identity without changing user experience.
- **Components:** identity repository interface, transactional/RPC upsert, feature flag, repair metrics.
- **Database impact:** database function or transaction support; no removal.
- **Tests:** concurrency, repeated start, null username/name, partial-failure recovery, admin-field preservation.
- **Acceptance:** live `/start` succeeds; one legacy + one normalized identity; zero role/Divisi/preference resets.
- **Dependencies:** Slice 2 reconciled identity.
- **Rollback boundary:** flag restores the current repository immediately.

## Slice 4 — Authenticated IT administration

- **Goal:** replace shared-key-only global administration with actor-aware permission/scope enforcement and dynamic catalogs.
- **Components:** authentication adapter, authorization middleware/service, Divisi/role/user APIs, Admin UI catalog loading, audit.
- **Database impact:** activation/invite/session metadata only if required by selected auth provider.
- **Tests:** ADMIN cross-Divisi denial, IT permission checks, SYSTEM_ADMIN protected actions, browser never receives server key.
- **Acceptance:** only active IT users with permission can manage users/config; every mutation attributed; emergency bootstrap documented and constrained.
- **Dependencies:** Slices 1–3.
- **Rollback boundary:** controlled feature flag to old Admin API during transition.

## Slice 5 — Task core

- **Goal:** implement task lifecycle, activity, relationships, and audit through service/API only.
- **Components:** task migrations, repository/service/routes, transition validator, overdue projection.
- **Database impact:** `tasks`, `task_activities`, `task_relationships`.
- **Tests:** lifecycle matrix, assignee updates, terminal timestamps, evidence/activity, relationship constraints, audit transaction.
- **Acceptance:** same-Divisi task flow works with permission/scope; no task UI or Telegram wizard yet.
- **Dependencies:** authenticated users/authorization.
- **Rollback boundary:** disable isolated task routes.

## Slice 6 — Cross-Divisi policy and approvals

- **Goal:** enforce configurable default-deny collaboration.
- **Components:** rule repository/service, IT management API, scope codes, approval records for activated approval rules.
- **Database impact:** collaboration rules and, if needed, task approvals.
- **Tests:** confirmed allow, unspecified deny, approval gating, requester visibility, owner execution, rule audit.
- **Acceptance:** a customer-defined cross-Divisi relationship works only under an approved active rule; missing rules deny and no all-to-all assignment exists. The historical ONPAGE_B2C-to-CONTENT_CREATOR rule is legacy installation state, not a product default.
- **Dependencies:** Slice 5 and business approval of v1 active rows.
- **Rollback boundary:** deactivate rules/routes; same-Divisi tasks remain.

## Slice 7 — CSV import with preview

- **Goal:** optional authorized bulk task creation with traceability.
- **Components:** template endpoint, parser/validator, batch model, preview/confirm API; add XLSX library only if XLSX is approved.
- **Database impact:** `task_import_batches`; staging rows only if implementation requires them.
- **Tests:** malformed files, unknown Divisi/assignee, unauthorized cross-Divisi rows, mixed valid/invalid preview, repeat confirm idempotency.
- **Acceptance:** no task is created before confirmation; every imported task references its batch; server rechecks authorization.
- **Dependencies:** Slices 5–6.
- **Rollback boundary:** disable import endpoints; manually created tasks unaffected.

## Slice 8 — Automation events and normalized notification routing

- **Goal:** add event idempotency, IT-controlled routes, and durable delivery without changing the n8n contract.
- **Components:** event/route/delivery migrations, resolver comparison mode, IT route API, delivery recorder.
- **Database impact:** event types, events, routes, deliveries.
- **Tests:** legacy parity, mandatory routes, Divisi/role/user targets, duplicate event ID, partial Telegram failures, provider/internal codes.
- **Acceptance:** recipient diffs reviewed; normalized resolver enabled behind flag; existing endpoint response remains compatible.
- **Dependencies:** identity/roles/Divisi and authenticated IT admin.
- **Rollback boundary:** switch resolver back to legacy booleans.

## Slice 9 — Alert policy and acknowledgement foundation

- **Goal:** evaluate configurable material alerts with dedupe/cooldown and auditable acknowledgement.
- **Components:** policy validators, alert instance state machine, aggregation scheduler boundary, acknowledgement service.
- **Database impact:** alert policies, instances, acknowledgements.
- **Tests:** value+baseline+duration+impact fixtures, absolute floor, strategic override, fingerprint dedupe, cooldown, acknowledgement/escalation.
- **Acceptance:** test events produce deterministic severity; normal high-volume alerts aggregate; acknowledged alerts do not repeat-escalate.
- **Dependencies:** Slice 8 events/routes; approved seed policies.
- **Rollback boundary:** deactivate policies and retain existing direct events.

## Slice 10 — First real report capability

- **Goal:** implement one verified report end-to-end with authorization and freshness, establishing the catalog pattern.
- **Components:** report catalog, capability registry, one real source adapter, freshness/result DTO, Telegram/API entry point later as separately approved.
- **Database impact:** `report_catalog`; justified snapshot metadata only if source requires it.
- **Tests:** OWNER authorization, ADMIN own-Divisi isolation, stale-source labeling, source failure, no fabricated values.
- **Acceptance:** output is calculated from the real source at request time and includes source/update/freshness.
- **Dependencies:** authorization plus an approved source contract.
- **Rollback boundary:** disable catalog entry/capability; no source-of-truth data changed.

## Slice 11 — IT monitoring and incidents

- **Goal:** separate technical health/incidents from Owner business summaries.
- **Components:** health collectors, incident lifecycle, retry/latency views, sanitized provider/internal error mapping.
- **Database impact:** integration health snapshots and incidents.
- **Tests:** IT-only detail, Owner summary redaction, stale heartbeat, incident transitions, sensitive-data sanitization.
- **Acceptance:** IT sees actionable diagnostics; OWNER sees only business-level automation state.
- **Dependencies:** automation events/deliveries and real integration signals.
- **Rollback boundary:** fall back to existing logs and `/health`.

## Future automated test strategy

### Regression and migration

- Existing Telegram `/start` success/fallback and repeat idempotency.
- Concurrent registration uniqueness and admin-managed-field preservation.
- Backfill rerun, partial backfill recovery, bridge reconciliation, old/new DTO parity.
- Supabase diagnostic exact cleanup and secret-redaction tests.

### Authorization isolation

- STAFF own tasks versus unrelated tasks.
- ADMIN can access home-Divisi tasks/reports and cannot access another Divisi.
- OWNER can access registered cross-Divisi business reports but not technical detail by default.
- IT with technical permission can access monitoring but not unrelated business reports.
- `SYSTEM_ADMIN` grants governance only; transfer leaves an auditable active authority.
- Every protected endpoint has allow and deny tests; deny is the default.

### Tasks and collaboration

- Same-Divisi create/assign/update/complete.
- Cross-Divisi active allow, explicit deny, missing-rule deny, approval-required pending flow.
- Requesting Divisi visibility versus owner Divisi execution rights.
- Lifecycle transition table, completed timestamp, calculated overdue.
- Activity/evidence append and task/audit atomicity.
- Relationship inverse queries, duplicate/self/cycle policy where applicable.

### Import

- CSV encoding/header/size/type limits and formula-injection-safe export.
- Unknown/disabled Divisi, ambiguous assignee, unauthorized target.
- Preview counts, mixed rows, confirmation idempotency, batch provenance.

### Notifications and alerts

- Legacy/normalized recipient parity before cutover.
- User preference versus mandatory operational route.
- Event idempotency and delivery retry isolation.
- Business versus technical routing (OWNER material alerts, IT system errors).
- Policy threshold boundaries, absolute impact floor, duration, stale source.
- High-volume aggregation, fingerprint dedupe, cooldown, escalation, acknowledgement.

### Security

- Service credential never included in browser bundles/responses/logs.
- Shared/internal key comparisons and missing-key rejection.
- RLS has no public write policy.
- Database/provider diagnostics redact secrets, headers, sensitive payload, and unnecessary identifiers.
- Audit before/after state uses field allowlists.
