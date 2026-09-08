# P0-13 Taxonomy Inventory

Preparation/inventory only. No design, no migration, no code changes. Every claim below is backed by a file/line inspected on 2026-09-09 against the working tree at commit `c670907` (P0-11/P0-12 files present as uncommitted work). Historical migrations are inventoried but NOT recommended for editing.

## Scope

What was swept, per the required inspection list:

1. Division code literals — migrations, `src/`, `scripts/`, `tests/`, `docs/`.
2. Role code literals — same sweep.
3. Task category literals — `src/tasks`, `src/ingestion`, `src/reporting`, `src/repositories`, docs.
4. Notification taxonomy coupled to business structure — `src/types/index.ts`, `telegram_users` schema, recipient resolver.
5. Division collaboration rules — migration `202608290005`, repository, service, IT console.
6. Identity legacy mappings — `legacy_division_value`/`legacy_role_value` SQL functions, `src/identity/legacy-mapping.ts`, `src/app.ts` fallback, reconciliation.
7. SYSTEM_ADMIN candidate validation — `202608290003`, `202609020001`, `202609090001`.
8. OWNER assumptions — task actor, reporting, critical alerts.
9. Installer/runtime checks — `scripts/check-*.ts`, `scripts/deploy/`, fresh-install runtime checker.
10. Migrations seeding customer-operational data — full 14-migration chain read for seed/data statements.
11. Tests asserting division/role codes — grep across `tests/`.
12. Docs containing origin-company organizational state — grep across `docs/`.
13. CSV import assumptions — `src/ingestion/csv-parser.ts`, `task-ingestion.service.ts`.
14. Reporting assumptions by division — `src/reporting`, `src/services/reporting.service.ts`.
15. Task ingestion/integration assumptions — `src/services/task-ingestion.service.ts`, `automation-validation.ts`.
16. Alert evaluator assumptions — `src/services/critical-alert-evaluator.service.ts`, `202609010004`.
17. Admin UI assumptions — `/api/admin/users/catalogs` endpoint, user-management routes.
18. Telegram/user mapping assumptions — `telegram_users` table, `src/telegram/*`, `src/repositories/telegram-users.repository.ts`.

Not swept (out of scope): design of the transition, editing migrations, live database inspection.

## Executive Summary

Taxonomy is hardcoded at four distinct layers, and they have very different remediation paths:

1. **Database seed data (worst for fresh installs).** Migration `202608290001` unconditionally inserts 9 divisions — 8 of which are origin-company operational divisions (PURCHASING, SALES_GROSIR, DIGITAL_MARKETING, CONTENT_CREATOR, ONPAGE_B2C, SHOPEE_LIVE, GUDANG, MANAGEMENT) plus IT. Migration `202608290005` seeds exactly one origin-company collaboration rule (ONPAGE_B2C → CONTENT_CREATOR). Every fresh customer receives all of it, because the migration chain is forward-only.
2. **Database function logic.** `validate_system_admin_candidate`, `assign_system_admin`, and `update_user_access` (migration `202608290003`) require the literal division code `'IT'`, and `update_user_access` requires legacy display-name mappings (`legacy_division_value`/`legacy_role_value`) that are origin-company tables-in-code. Migration `202609090001` (`bootstrap_first_admin`) requires literal `'IT'` + `'ADMIN'`. Migration `202609010004` guards acknowledgment behind `roles.code = 'OWNER'`.
3. **Application source.** Division codes (`IT`, `OWNER`) appear in ~12 runtime files (routes, services, console); `TASK_CATEGORIES = ["AFFILIATE"]` is a compiled enum; the reporting console hardcodes `CONTENT_CREATOR` + `AFFILIATE`; the notification type system (`STOCK_CRITICAL`, `PURCHASE_RECOMMENDATION`, `SALES_FOLLOWUP`, `MARKETING_ALERT`, `CONTENT_OPPORTUNITY`, `OWNER_DAILY_REPORT`) encodes the origin business's operational domains as fixed notification categories with fixed per-user boolean preferences.
4. **Legacy identity mapping.** Display-name → code mappings (`Purchasing` → `PURCHASING`, `Shopee Live`/`Live Shopee` → `SHOPEE_LIVE`, etc.) exist twice in SQL and once in TypeScript, plus a `UNASSIGNED` sentinel and an `app.ts` fallback resolver with literal `divisionId: 1`.

A genuinely data-driven substrate already exists and should be preserved: divisions/roles/permissions are real tables; collaboration rules are real table rows; `tasks.task_category` is a free-form column with only a format constraint; the admin UI catalogs endpoint (`/api/admin/users/catalogs`) and the IT console read catalogs dynamically; CSV/automation intake resolves `owner_division` by code lookup against the divisions table, not against a compiled list. The P0-13 problem is therefore seed content, function-embedded literals, app-side enums, and the reporting/notification catalogs — not the storage model.

Counts: 9 distinct division codes hardcoded (8 origin-company + IT) plus the `UNASSIGNED` sentinel; 3 role codes (STAFF/ADMIN/OWNER) plus 6 legacy display-name role values (Staff, Admin, PIC, Supervisor, Manager, Owner — of which PIC/Supervisor/Manager have no database mapping at all); 1 task category (AFFILIATE); 4 migrations contain customer-operational seed data.

## Current Taxonomy Model

| Concept | Storage | Seeded by | Consumed by |
| --- | --- | --- | --- |
| Divisi (division) | `public.divisions` (code, name, active) | `202608290001` (9 rows) | users, tasks ownership, collaboration rules, reporting, intake resolution, catalogs |
| Business role | `public.roles` (code, name) | `202608290001` (3 rows) | users, role_permissions, OWNER guards, bootstrap |
| Permissions | `public.permissions` + `role_permissions` | `202608290001` (23 permissions, 3 role grants) | actor permission sets, checkers |
| System authority | `public.system_authority_assignments` (`SYSTEM_ADMIN` only) | none (runtime only) | admin actor resolution, IT-console, integration admin |
| Cross-Divisi collaboration | `public.division_collaboration_rules` (directional, default-deny, scope `ALL` only) | `202608290005` (1 origin rule) | task service cross-division checks, IT console |
| Task category | `tasks.task_category` text column, regex `^[A-Z][A-Z0-9_]{0,49}$`, nullable | no DB seed | compiled enum `TASK_CATEGORIES`, reporting, intake validation |
| Notification type/preference | `telegram_users` boolean columns (`stock_alert` … `owner_report`, `system_error`) | column defaults only | `NOTIFICATION_PREFERENCE_BY_TYPE` mapping in `src/types/index.ts`, recipient resolver |
| Legacy identity mapping | `telegram_users.division`/`role` display-name text columns + `legacy_telegram_user_id` | `UNASSIGNED` default | `legacy_division_value`/`legacy_role_value` SQL functions, `mapLegacyDivision/mapLegacyRole`, reconciler |
| Admin UI catalogs | dynamic query of divisions/roles | — | `/api/admin/users/catalogs`, IT console |

Key structural fact: the storage is already configuration-shaped. There is no `divisions.code` check constraint limiting the code set; `task_category` is free-form at the DB level; `division_collaboration_rules` is a plain table. Hardcoding lives in seeds, function bodies, and TypeScript constants.

## Hardcoded Division Inventory

| Value | Location | Type | Runtime Impact | Classification | Notes |
| --- | --- | --- | --- | --- | --- |
| PURCHASING | `202608290001:125`; `202608290002:87,223`; `202608290003:15`; `src/governance/catalog.ts:2`; `src/identity/legacy-mapping.ts:2`; `src/types/index.ts:4` | Seed + legacy display mapping | Seeded row; consumed only by legacy display-name mapping and catalogs | F / REMOVE FROM FRESH INSTALL | Origin company purchasing division. No function logic depends on it. |
| SALES_GROSIR | `202608290001:126`; `202608290002:88,224`; `202608290003:16`; `catalog.ts:3`; `legacy-mapping.ts:3`; `src/types/index.ts:5` | Seed + legacy display mapping | Same as above | F / REMOVE FROM FRESH INSTALL | Origin wholesale-sales division. |
| DIGITAL_MARKETING | `202608290001:127`; `202608290002:89,225`; `202608290003:17`; `catalog.ts:4`; `legacy-mapping.ts:4`; `types/index.ts:6` | Seed + legacy display mapping | Same | F / REMOVE FROM FRESH INSTALL | |
| CONTENT_CREATOR | `202608290001:128`; `202608290002:90,226`; `202608290003:18`; `catalog.ts:5`; `legacy-mapping.ts:5`; `types/index.ts:7`; `202608290005:37` (collab seed target); `src/services/reporting.service.ts:25` (report division label); `src/repositories/reporting.repository.ts:19` (indirect via owner division + category) | Seed + legacy mapping + reporting/report coupling | Seeded row; target of the only seeded collaboration rule; reporting definition `AFFILIATE_TASK_STATUS` is bound to it | F / REMOVE FROM FRESH INSTALL | Highest-coupled origin division: seed + collab rule + reporting console. |
| ONPAGE_B2C | `202608290001:129`; `202608290002:91,227`; `202608290003:19`; `catalog.ts:6`; `legacy-mapping.ts:6`; `202608290005:37` (collab seed source); `scripts/check-collaboration-schema.ts:18-19,30-31`; `docs/architecture/cross-division-rules-v1.md:32` | Seed + legacy mapping + collab rule source | Seeded row; source of the only seeded collaboration rule; schema checker asserts the rule exists | F / REMOVE FROM FRESH INSTALL | Checker hardcodes the seed, so checker must transition with the seed. |
| SHOPEE_LIVE | `202608290001:130`; `202608290002:92-93` (both "Live Shopee" and "Shopee Live" display variants); `202608290003:20`; `catalog.ts:7`; `legacy-mapping.ts:7-8`; `types/index.ts:8` | Seed + legacy display mapping (two variants) | Same as generic origin rows | F / REMOVE FROM FRESH INSTALL | Display-name duplication is itself evidence of origin-data messiness. |
| GUDANG | `202608290001:131`; `202608290002:94,230`; `202608290003:21`; `catalog.ts:8`; `legacy-mapping.ts:9`; `types/index.ts:9` | Seed + legacy display mapping | Same | F / REMOVE FROM FRESH INSTALL | Warehouse division — plausible ICP preset content, not schema. |
| MANAGEMENT | `202608290001:132`; `202608290002:95,231`; `202608290003:22`; `catalog.ts:9`; `legacy-mapping.ts:10`; `types/index.ts:10` | Seed + legacy display mapping | Same | F / REMOVE FROM FRESH INSTALL | Plausible ICP preset content. |
| IT | `202608290001:133`; `202608290002:54,96,232`; `202608290003:23,90,112,209,281` (`validate_system_admin_candidate`, `update_user_access`, `assign_system_admin`); `202609020001:56` (`assert_it_system_admin`); `202609090001:83,125` (bootstrap); `src/repositories/users.repository.ts:28`; `src/routes/critical-alerts.routes.ts:23`; `src/routes/admin-notifications.routes.ts:13`; `src/routes/admin-user-management.routes.ts:55`; `src/services/integration-administration.service.ts:64`; `src/services/collaboration-rule-management.service.ts:66`; `src/telegram/it-console.ts:111`; `catalog.ts:10`; `legacy-mapping.ts:11`; `types/index.ts:11` | Seed + **function-embedded logic** | Blocks all SYSTEM_ADMIN assignment, bootstrap, integration administration, alert ops, user management, and collaboration management unless the actor is in division `IT`; `update_user_access` refuses users without legacy mapping | E / LEGACY COMPATIBILITY — the P0-13/P0-14 removal target | The ADR P0-11 already named this as the single bridge; the inventory shows the bridge is wider than bootstrap: 6 SQL sites + 7 TS sites. |
| UNASSIGNED (sentinel) | `202608260001:11-12` (column defaults); `src/app.ts:112-115`; `src/identity/legacy-mapping.ts:21,26`; `src/repositories/telegram-users.repository.ts:34,36` | Sentinel string in legacy columns | Distinguishes unassigned Telegram registrations; drives "pending" filters | E / LEGACY COMPATIBILITY | Sentinel-in-data antipattern; harmless while legacy columns exist; dies with the legacy mapping. |

No other division code literals were found in `src/` or `scripts/` outside tests/docs. CSV and automation intake resolve `owner_division` against the divisions table by code (`task-ingestion.service.ts:92-106`) — data-driven, no literal.

## Hardcoded Role Inventory

| Value | Location | Type | Runtime Impact | Classification | Notes |
| --- | --- | --- | --- | --- | --- |
| STAFF | `202608290001:138,181`; `catalog.ts:13,45-52`; `legacy-mapping.ts:15`; `types/index.ts:15` ("Staff") | Seed + permission grant | Lowest-privilege role grant set; legacy display mapping | B / GENERIC DEFAULT (verify semantics) | Permission set is division-scoped operational work — a defensible product default. |
| ADMIN | `202608290001:139,198`; `202609090001:86,126` (bootstrap); `catalog.ts:13,53-63`; `legacy-mapping.ts:16`; `types/index.ts:16` ("Admin"); `tests/bootstrap/*` | Seed + permission grant + bootstrap dependency | Division-scoped viewing/task ops; required by `bootstrap_first_admin` as the first admin's business role | B + E (bootstrap bridge) | No governance permissions granted (verified: `user.manage`/`system_authority.manage` granted to no role — `202608290001`, asserted by `tests/user-management/user-management.test.ts:80`). |
| OWNER | `202608290001:140,211`; `202609010004:189-190` (alert ACK guard); `src/repositories/task-users.repository.ts:89` (singleton trusted-owner actor); `src/services/task-actor.service.ts:29`; `src/services/reporting.service.ts:54-56`; `src/services/critical-alert.service.ts:43`; `catalog.ts:13,64-70`; `legacy-mapping.ts:17`; `types/index.ts:18` ("Owner") | Seed + permission grant + **structural singleton semantics** | Exactly-one-active-OWNER assumption in `findTrustedOwnerActorUser` (503 otherwise); cross-division reports, alert acknowledgment, approvals gated on `roles.code = 'OWNER'` | B (role exists as default) + structural redesign question | The singleton "exactly one OWNER" contract is embedded in application queries, not constraints. Whether "the business owner" is a product concept or customer config is a P0-13 design question. |
| PIC / Supervisor / Manager | `src/types/index.ts:12` only (`ROLES` legacy display enum) | Display enum, no DB mapping | None at runtime — `mapLegacyRole` cannot map them; no seed, no grant | F / REMOVE | Dead origin-workplace hierarchy names in the Telegram-era type surface. |
| UNASSIGNED (sentinel) | `202608260001:12`; `src/app.ts:113`; `legacy-mapping.ts:26` | Sentinel string | Same pattern as division sentinel | E / LEGACY COMPATIBILITY | |

## Task Category Inventory

| Value | Location | Type | Runtime Impact | Classification | Notes |
| --- | --- | --- | --- | --- | --- |
| AFFILIATE | `src/tasks/types.ts:4` (`TASK_CATEGORIES = ["AFFILIATE"]`); `src/tasks/task-validation.ts:59`; `src/ingestion/automation-validation.ts:24-25`; `src/services/task-ingestion.service.ts:116-117`; `src/services/task.service.ts:280` (`category()` validation); `src/repositories/reporting.repository.ts:19` (`.eq("task_category", "AFFILIATE")`); `src/services/reporting.service.ts:25` (`AFFILIATE_TASK_STATUS` definition + `division: "CONTENT_CREATOR"`); `src/reporting/types.ts:18`; `docs/go-live-task-category-matrix.md:9` | Compiled enum + report definition | Every intake path rejects any category except AFFILIATE; the only report is hardwired to CONTENT_CREATOR-owned AFFILIATE tasks | C + F (report definition is origin-specific) | The DB column is already free-form (`202609010003` regex-only). The hardcode is entirely application-side: one array + one report. Categories are the easiest taxonomy win in P0-14. |
| Task category format constraint | `202609010003:4-8` | Core schema | Format-only (`^[A-Z][A-Z0-9_]{0,49}$`), nullable, reporting index on `(owner_division_id, task_category)` | A / CORE | Keep; it is category-agnostic. |

## Collaboration Rule Dependencies

- Storage is configuration-shaped: `division_collaboration_rules` is a plain table, default-deny, directional, `task_scope` currently constrained to `'ALL'` only (`202608290005:9`). Adding scope values later is a forward migration, not a redesign. Classification: A / CORE.
- The only seeded rule is origin-company data: ONPAGE_B2C → CONTENT_CREATOR, allowed, no approval (`202608290005:29-41`), with its own audit row from `source = 'migration_seed'`. Classification: F / REMOVE FROM FRESH INSTALL (replace with onboarding-time customer configuration or an ICP preset).
- `scripts/check-collaboration-schema.ts:18-19` statically asserts the migration contains exactly that origin rule, and `:30-31` live-checks it. The checker encodes the origin-company seed as a schema contract; it must transition in lockstep or fresh installs will "fail" a checker for not having origin data.
- Management surfaces are code-free of division literals except the IT actor guard (`collaboration-rule-management.service.ts:66`, IT console `:111`): rule CRUD itself is data-driven. Good.
- `src/app.ts:112-115` fallback resolver hardcodes `divisionId: 1`/`roleId: 1` for legacy principals — a positional-ID assumption that only works if seed row 1 is what origin data expects. Classification: F / REMOVE or parameterize.

## Identity / Telegram Dependencies

- `telegram_users.division`/`role` are free-text display-name columns defaulting to `'UNASSIGNED'` (`202608260001:11-12`) — the legacy workplace taxonomy lives in customer data.
- Display-name → code mapping exists twice in SQL (`legacy_division_value`/`legacy_role_value` in `202608290002:87-101,223-240` and again in `202608290003:15-37`) and once in TS (`src/identity/legacy-mapping.ts`). Three copies of the same origin-company dictionary. Classification: E, remove only together with `update_user_access`'s legacy requirement.
- `update_user_access` (`202608290003`) refuses any user whose `legacy_telegram_user_id is null` and whose division/role has no legacy display mapping — this is why the bootstrap admin is not editable (documented in ADR P0-11) and why identity creation historically required Telegram.
- `src/app.ts:108-118` contains an injection-time fallback access-state resolver with hardcoded `divisionId: 1` / `roleId: 1` and `role.toUpperCase()` — dead code in production wiring (client path is used) but a literal-ID trap.
- Reconciliation (`scripts/reconcile-legacy.ts`, `src/services/identity-reconciliation.service.ts`) tolerates null legacy ids (bootstrap admin is ignored, per ADR P0-11) but otherwise reconciles legacy display names to normalized codes — coupled to the origin dictionary.
- Notification recipient routing reads the origin-domain preference booleans on `telegram_users` (`stock_alert` … `owner_report`); a customer whose business has no "purchasing" or "content" concept inherits meaningless preference columns.

## SYSTEM_ADMIN / OWNER Dependencies

SYSTEM_ADMIN (authority — genuinely core):

- `authority_code` check constraint permits only `'SYSTEM_ADMIN'` (`202608290001`). A / CORE.
- The **candidate rule** is the problem: `validate_system_admin_candidate` trigger and `assign_system_admin` require `users.active AND divisions.code = 'IT'` (`202608290003:90,281`); `assert_it_system_admin` (`202609020001:56`) repeats it. E / LEGACY BRIDGE.
- `bootstrap_first_admin` selects `divisions.code = 'IT'` + `roles.code = 'ADMIN'` (`202609090001:83-86`) and hardcodes `'division_code', 'IT'` in the audit payload (`:125-126`). E / LEGACY BRIDGE — named by ADR P0-11 for P0-13/P0-14 removal via a capability flag (e.g. `divisions.grants_system_authority`).
- Application-side IT guards mirroring the SQL rule: `users.repository.ts:28`, `critical-alerts.routes.ts:23`, `admin-notifications.routes.ts:13`, `admin-user-management.routes.ts:55`, `integration-administration.service.ts:64`, `collaboration-rule-management.service.ts:66`, `telegram/it-console.ts:111`. All E — they must move to the same capability/authority predicate the SQL moves to, or they will diverge.

OWNER (business role with singleton semantics):

- `findTrustedOwnerActorUser` demands exactly one active OWNER (`task-users.repository.ts:89`) — a 503 if zero, and a hidden assumption if a customer legitimately has two owners.
- Alert acknowledgment requires `roles.code = 'OWNER'` in SQL (`202609010004:189`) and reporting/approval surfaces require it in TS (reporting.service, critical-alert.service, task-actor.service).
- Classification: B for the role's existence, but the **singleton + cross-division-authority semantics** are an origin-workplace assumption that P0-13 must either generalize (e.g. permission-driven) or document as a product default. This is a design question, not settled.

## Migration Seed Inventory

| Migration | Seed/Data | Required for Schema? | Customer-Specific? | Safe for Fresh Customer? |
| --- | --- | --- | --- | --- |
| 202608260001_create_telegram_users | Table + preference boolean columns (origin-domain alert preferences); `UNASSIGNED` defaults | Schema yes; preference column set is origin-flavored | Preference columns: yes (origin domains) | Columns tolerable; semantics legacy |
| 202608270001_add_missing_telegram_users_division | Forward repair adding `division` column | Schema only | No | Yes |
| 202608290001_create_governance_foundation | **9 divisions (8 origin + IT), 3 roles, 23 permissions, 3 role_permission grants; SYSTEM_ADMIN constraint** | Tables/constraints: required. Division rows: data. Roles/permissions: product defaults | **Yes — division rows are origin-company state** | No (divisions); roles/permissions arguably yes |
| 202608290002_create_normalized_identity | `legacy_division_value`/`legacy_role_value` mapping functions (origin display names, incl. dual Shopee variants) | Functions required by `update_user_access` | **Yes — dictionary of origin display names** | Functionally dead on a fresh install with no legacy data, but present |
| 202608290003_create_it_user_management | Second copy of legacy mapping functions; **IT candidate rule in trigger + functions** | Logic required for user management to work at all | The IT literal + legacy dictionary: yes | No — but cannot be removed without the P0-13/P0-14 redesign |
| 202608290004_create_task_core | None (schema only) | — | No | Yes |
| 202608290005_create_division_collaboration_rules | **1 origin rule: ONPAGE_B2C → CONTENT_CREATOR** + audit row | Table required; seed row is data | **Yes** | No |
| 202609010001_create_task_ingestion_foundation | None (schema only) | — | No | Yes |
| 202609010002_create_task_notification_foundation | Schema; channel check includes `WHATSAPP` (unimplemented channel) | Schema only | Channel list is product-level, not customer data | Yes (WHATSAPP is a deferral, not taxonomy) |
| 202609010003_add_task_category | Column + index + comment; no category values | Schema only | No | Yes |
| 202609010004_create_critical_alert_foundation | Alert types are product-level enum; **OWNER guard** (`roles.code = 'OWNER'`) | Schema + logic | No (role literal is product-level) | Yes, pending OWNER semantics decision |
| 202609020001_create_business_identity_and_integration_capabilities | Schema; `assert_it_system_admin` with IT literal | Schema + logic | IT literal: legacy bridge | No — but bridge-wide, not customer data |
| 202609080001_create_notification_event_intake | None (schema only; already applied remotely — immutable identity) | — | No | Yes |
| 202609090001_create_first_admin_bootstrap | Schema + RPC with IT/ADMIN literals (already applied remotely — immutable identity) | Logic | IT/ADMIN literals: legacy bridge | No, until P0-13/P0-14 removes the bridge via a NEW forward migration |

**Migrations containing customer-operational seed data: 4** (`202608290001`, `202608290002`, `202608290003` (mapping functions), `202608290005`).

## Test Dependencies

Tests encode taxonomy assumptions in fixtures; a naive global replacement would silently weaken them. Files with division/role/category literals:

| Test file | Encoded assumption |
| --- | --- |
| `tests/bootstrap/first-admin-bootstrap.test.ts` | `division: "IT"`, `role: "ADMIN"` result contract; no-`'OWNER'` assertion |
| `tests/bootstrap/first-admin-bootstrap-database.test.ts` | Live fixture seeds via `d.code='IT' and r.code='ADMIN'`; renames IT to `IT_MISSING` to prove `TAXONOMY_UNAVAILABLE`; asserts no OWNER exists |
| `tests/user-management/user-management.test.ts` | Divisions `IT`, `SALES_GROSIR`; `updateLegacyAccess("IT", "Staff")` legacy path; OWNER permission negation read from migration text |
| `tests/collaboration/cross-division.test.ts` | Origin division codes for rule scenarios |
| `tests/reporting/reporting-owner-console.test.ts` | AFFILIATE/OWNER reporting contract |
| `tests/ingestion/task-ingestion.test.ts` | Division codes + AFFILIATE category validation |
| `tests/telegram/it-console.test.ts` | IT-console authorization with IT division |
| `tests/telegram/task-console.test.ts`, `tests/telegram/authorization-state.test.ts` | Division/role display values |
| `tests/identity/normalized-identity.test.ts` | Legacy display-name mapping (origin names) |
| `tests/go-live/stage2-foundation.test.ts` | IT division fixture; forbidden capability-code list incl. `SYSTEM_ADMIN`, `OWNER` |
| `tests/tasks/task-core.test.ts` | AFFILIATE category |
| `tests/alerts/critical-alert-engine.test.ts`, `tests/security/*`, `tests/reminders/*`, `tests/notifications/*` | IT/OWNER actor fixtures |

Pattern: tests will need intent-preserving updates (fixture catalogs defined once, asserted capability-first) rather than blind string replacement — e.g. `tests/user-management` asserts permission grants by parsing migration SQL, which will need to follow whatever P0-14 does to seeds.

## Documentation / Origin-State Inventory

Docs containing origin-company organizational state (candidates for P0-15, but coupled to P0-13 truth):

- `docs/go-live-collaboration-matrix.md` — origin collaboration relationships.
- `docs/go-live-task-category-matrix.md` — AFFILIATE category bound to CONTENT_CREATOR, marked CONFIRMED.
- `docs/architecture/cross-division-rules-v1.md:32` — ONPAGE_B2C → CONTENT_CREATOR as a "CONFIRMED relationship".
- `docs/architecture/reporting-owner-console.md` — OWNER console semantics tied to origin reporting.
- `docs/architecture/target-domain-model.md`, `implementation-roadmap.md`, `governance-foundation.md`, `normalized-identity.md` — describe the IT/origin seed as current truth.
- `docs/go-live-integration-registry.md:25`, `docs/go-live-configuration.md:75,93-96` — Shopee/Meta as origin-marketplace-specific sources.
- `docs/beta-readiness.md:65` — Shopee/BigSeller connectors context.
- `docs/migration/baseline-v1.md:52` — explicitly records "Divisi and Role options are duplicated/hard-coded in server and browser" as a known defect.
- `docs/adr/P0-11-first-admin-bootstrap.md` — already documents the IT/ADMIN bridge and its removal plan (input, not cleanup).

## Core vs Default vs Customer vs Preset Matrix

| Item | Core | Generic Default | Customer Config | ICP Preset | Legacy Compatibility | Remove |
| --- | --- | --- | --- | --- | --- | --- |
| `divisions` / `roles` / `permissions` / `role_permissions` tables + RLS | X | | | | | |
| `system_authority_assignments` (`SYSTEM_ADMIN` constraint) | X | | | | | |
| `division_collaboration_rules` table (default-deny model) | X | | | | | |
| `tasks.task_category` column (format-only) + reporting index | X | | | | | |
| `telegram_users` preference columns | X (storage) | | (values are origin-domain) | | | |
| Roles STAFF / ADMIN / OWNER + permission grants | | X (verify semantics; OWNER singleton needs a decision) | | | | |
| Division rows PURCHASING, SALES_GROSIR, DIGITAL_MARKETING, CONTENT_CREATOR, ONPAGE_B2C, SHOPEE_LIVE, GUDANG, MANAGEMENT | | | | (GUDANG/MANAGEMENT plausible preset content) | | X from fresh install |
| Division row IT | | | | | X (SYSTEM_ADMIN candidate rule + bootstrap) | eventually |
| Legacy mapping functions (`legacy_division_value`/`legacy_role_value`, both SQL copies + TS copy) | | | | | X | eventually (with `update_user_access` legacy requirement) |
| `UNASSIGNED` sentinel | | | | | X | eventually |
| `app.ts` fallback `divisionId: 1 / roleId: 1` resolver | | | | | X | X (dead-in-production literal-ID trap) |
| `TASK_CATEGORIES = ["AFFILIATE"]` enum | | | X (should be data/config) | | | X (as a compiled enum) |
| `AFFILIATE_TASK_STATUS` report (CONTENT_CREATOR + AFFILIATE) | | | X (report definitions should be config) | | | X as hardcode |
| ONPAGE_B2C → CONTENT_CREATOR seeded rule | | | X | | | X from fresh install |
| Notification types STOCK_CRITICAL/PURCHASE_RECOMMENDATION/SALES_FOLLOWUP/MARKETING_ALERT/CONTENT_OPPORTUNITY/OWNER_DAILY_REPORT + preference booleans | | (SYSTEM_ERROR is generic) | X (business-domain alert categories) | | | as fixed set; long-term config |
| IT guards in routes/services/console (7 TS sites) | | | | | X | eventually (move to capability predicate) |
| OWNER singleton in `findTrustedOwnerActorUser` | | design decision needed | | | | as hard singleton |
| WHATSAPP channel value in check constraint | | | | | DEFER (P1+) | |
| ICP preset catalogs (e.g. Warehouse B2B+B2C set) | | | | X (new concept) | | |

## Fresh-Install Risks

What a new customer receives today if all 14 migrations run unchanged:

1. **Nine divisions**, eight of which describe another company's org chart (Purchasing, Sales Grosir, Digital Marketing, Content Creator, On Page/B2C, Shopee Live, Gudang, Management) — visible in catalogs, user assignment, task ownership, reporting.
2. **One collaboration rule between two of those foreign divisions**, pre-allowed.
3. **A mandatory IT division dependency**: first-admin bootstrap (`npm run setup`) fails with `TAXONOMY_UNAVAILABLE` if IT or ADMIN is missing — so the customer cannot even remove the origin divisions without breaking bootstrap and every admin operation.
4. **A reporting console whose only report is about the origin company's affiliate content tasks.**
5. **Notification preferences for stock/purchase/sales/marketing/content domains** that may not match the customer's business.
6. Roles STAFF/ADMIN/OWNER with permission grants — defensible defaults, but the OWNER singleton semantics arrive unexplained.
7. No mechanism (UI, CLI, or documented SQL-free path) to create/rename/delete divisions, roles, or categories — the customer cannot adapt without source edits, which is precisely the PRD §2.7 violation.

## Upgrade Risks

What could break if legacy taxonomy is removed blindly:

1. **Editing `202608290001`/`202608290005`** would change migration identities on existing installs and break the remote registry reconciliation just established by the P0-12 incident. All seed changes must be NEW forward migrations.
2. **Removing the IT division row** on any existing or fresh install breaks: `validate_system_admin_candidate` (no new SYSTEM_ADMIN can ever be assigned), `assign_system_admin`, `assert_it_system_admin` (integration administration dies), bootstrap (if not yet run), and the seven application-side IT guards (critical alerts, notifications admin, user management, collaboration management, IT console all refuse).
3. **Removing ADMIN** breaks `bootstrap_first_admin` on installs that have not bootstrapped.
4. **Removing legacy display-name mapping functions** breaks `update_user_access` for every legacy Telegram user on existing installs — user management becomes unusable mid-flight.
5. **Removing origin division rows** referenced by existing `users`, `tasks` (owner/requesting division FKs), collaboration rules, or audit trails would orphan live data on the origin-company instance. Fresh-install seeding and existing-install compatibility must be different code paths (parameterized seeding), not one shared edit.
6. **Changing the catalogs endpoint or CSV intake contract** breaks n8n/automation integrations that submit `owner_division` codes (D-008: external systems use Sotoayam contracts — contract stability review required).
7. **`scripts/check-collaboration-schema.ts` and `check-governance-foundation.ts`** assert today's seeds; changing seeds without updating checkers turns every future gate run red (or worse, if someone "fixes" the checker by weakening it).
8. **Test fixtures** referencing IT/SALES_GROSIR/AFFILIATE would fail wholesale under blind replacement; the permission-grant assertions that parse migration SQL would break structurally.

## P0-13 Design Inputs

Architectural questions Claude Code must answer in the P0-13 design (inventory evidence in parentheses):

1. **How to separate schema creation from customer data seeding.** `202608290001` mixes DDL with 9 division rows and 3 role rows; the design needs a "baseline catalog" concept distinct from migration DDL (fresh-install baseline vs versioned seed), without editing applied migrations (forward-only; the 4 seed migrations are immutable identities).
2. **How fresh installs avoid origin-company divisions.** The 8 origin rows must not reach fresh installs; the mechanism (post-migration removal? parameterized seed? new baseline contract?) must survive `npm run migrate` idempotency and the deployment migration gate.
3. **How existing installs retain compatibility.** The origin-company instance's live rows, FKs, and audit history must keep working; expand/contract per D-014, with the legacy dictionary kept until legacy Telegram users are gone or `update_user_access` is relaxed.
4. **Whether roles STAFF/ADMIN/OWNER remain product defaults.** STAFF/ADMIN grants look like defensible defaults; OWNER carries singleton semantics embedded in application queries (`task-users.repository.ts:89`, `202609010004:189`) — decide whether "owner" is a product concept, a permission set, or customer config.
5. **How first-admin bootstrap stops requiring literal IT.** ADR P0-11 already sketches the target (`divisions.grants_system_authority` capability or settings row); the design must also cover the 7 application-side IT guards so SQL and TS move to one predicate, plus `update_user_access`'s legacy requirement (which blocks editing the bootstrap admin).
6. **How collaboration rules become onboarding configuration.** Table is ready (A/CORE); the seeded origin rule must become onboarding config or an ICP preset item, and `check-collaboration-schema.ts`'s origin-rule assertion must transition with it.
7. **How task categories become data/config.** DB column is already free-form; `TASK_CATEGORIES` is a one-array enum with intake validation and one hardcoded report definition — define where categories live (table vs settings) and how reporting definitions reference them.
8. **How tests transition without blind global replacement.** Tests parse migration SQL for permission grants and fix IT/ADMIN fixtures; design should specify fixture catalogs and capability-first assertions so tests follow the new contract intentionally.
9. **Whether a fresh-install baseline/versioned seeding mechanism is needed** (e.g. an onboarding seed step after migrations, owned by `npm run setup` or a new command), and how it interacts with P0-16 install docs and the migration gate.
10. **How future ICP presets are represented** (starter division/role/category/collab sets selected at onboarding; presets are data, never schema; GUDANG/MANAGEMENT are the natural first preset candidates from the existing seed).

Deferred (not P0-13/P0-14): WhatsApp channel enablement (constraint already reserves the value, `202609010002:26`); escalation preset engine; ERP/BigSeller/Shopee/Meta connectors (D-016); multi-tenancy (D-002); notification-type configurability beyond the bridge (P2-01/P2-03 territory).

## Suggested Classification Summary

- **KEEP AS CORE:** divisions/roles/permissions/role_permissions tables + RLS; `system_authority_assignments`; `division_collaboration_rules` table + default-deny model; `tasks.task_category` column + index; `telegram_users` storage; alert-type/source enums (product-level); migration chain as-is.
- **GENERIC DEFAULT:** roles STAFF/ADMIN/OWNER + their permission grants (OWNER's singleton semantics flagged for a design decision); `SYSTEM_ERROR` notification preference; alert severity model.
- **CUSTOMER CONFIG:** divisions (per customer); collaboration rules; task categories; notification-type/preference catalog (business-domain alert categories); reporting definitions; the onboarding-time creation of all of the above.
- **ICP PRESET:** starter division/category/collab bundles (e.g. Warehouse B2B+B2C: Gudang & Stok, Sales B2B, Sales Marketplace, Finance, Delivery, Management) — new optional seeding surface, data only.
- **LEGACY BRIDGE:** IT division dependency in SQL (4 sites) + TS (7 sites); ADMIN dependency in bootstrap; legacy display-name mapping (3 copies); `UNASSIGNED` sentinel; `update_user_access` legacy-Telegram requirement; bootstrap-admin access-edit limitation.
- **REMOVE FROM FRESH INSTALL:** 8 origin-company division seed rows; ONPAGE_B2C→CONTENT_CREATOR seed rule; `AFFILIATE_TASK_STATUS` hardcoded report; origin-domain notification preference defaults as a fixed set; `app.ts` literal-ID fallback resolver; PIC/Supervisor/Manager display enum values.
- **DEFER:** WhatsApp channel; escalation presets; ERP/marketplace connectors; multi-tenancy; white-label; notification-type configurability engine.

## Open Questions

Evidence-backed only:

1. Does any production (origin-company) instance data reference origin division ids in ways a forward repair must preserve (task FKs, audit jsonb, collab rules)? Not verifiable from this repository — needs a read-only live check before P0-14 implementation.
2. Is the `findTrustedOwnerActorUser` exactly-one-OWNER contract a product invariant or an origin convenience? The schema has no constraint enforcing it; only the application query does (`task-users.repository.ts:89`). Design decision required.
3. Should the `task_scope = 'ALL'` check constraint on collaboration rules be widened (e.g. per-category scopes) now or after categories become data? (`202608290005:9`.)
4. Do any external n8n automations currently submit `owner_division` codes or `task_category=AFFILIATE` that would break under a customer-config category set? Not answerable from the repository — contract-impact review needed.
5. What is the intended relationship between the P0-11-sketched capability flag (`divisions.grants_system_authority`) and the existing IT-guards in TS — one shared predicate resolved from DB state, or authority-only? ADR P0-11:396-404 leaves the exact mechanism to P0-13.
6. Should `202608290002`/`202608290003`'s duplicate mapping-function copies be consolidated as part of the bridge removal, or left untouched to minimize blast radius on live installs? (Both copies are applied and immutable; a new forward migration can only add, not edit.)
