# ADR P0-13 — Operational Taxonomy Transition: Origin-Company Hardcode to Customer Configuration

## Status

Proposed — Revised After Adversarial Review

Design only. No production code, no migration, no deployment, and no live Supabase contact was performed for this ADR. Implementation is P0-14.

Revision 2 (2026-09-09) resolves every blocking finding in `docs/reviews/P0-13-architecture-review.md`.

## Context

Sotoayam is being hardened from an internal workplace tool into a commercial product sold one instance per customer (D-002). PRD §2 item 7 and §5.2 require customer operational taxonomy to be data/configuration rather than compiled source; D-011 records the same as an approved target with a legacy compatibility adapter permitted during transition.

`docs/reviews/P0-13-taxonomy-inventory.md` (2026-09-09, commit `c670907`) established that taxonomy is hardcoded at four layers: migration seed data, database function bodies, TypeScript constants, and a legacy display-name dictionary. `docs/adr/P0-11-first-admin-bootstrap.md` deliberately shipped a two-code bridge (`IT` division + `ADMIN` role) in `bootstrap_first_admin` and named P0-13/P0-14 as the owner of its removal.

The constraint that shapes this design: migration history is immutable. `202609080001` and `202609090001` are already applied to a linked remote project (the P0-12 incident recorded in `AI_HANDOFF.md`), and D-013/D-014 forbid blind renames and require expand/contract. Every change below is a **new forward migration**.

### Disposition of adversarial findings

| Finding | Severity | Disposition in this revision |
| --- | --- | --- |
| F-001 heuristic lineage can destroy a dormant existing database | HIGH | **Accepted in full.** Row-count classification is deleted. Migrations are now unconditionally non-destructive on every install. Fresh-only retirement moves out of migration time into the operator-invoked clean-install workflow, authorized by positive provenance. Row-count evidence is demoted from *authorization* to *veto*: it can only ever block retirement, never permit it. See **Positive Install Provenance** |
| F-002 inverted `coalesce` precedence discards customer renames | HIGH | **Accepted in full.** Precedence inverted; normalized rows are the source of truth and the legacy dictionary is a fallback only. See **Legacy Identity Transition** |
| F-003 mandatory `ADMINISTRATION` division re-creates the `IT` flaw | MEDIUM | **Accepted in full.** No system-managed division is created on any install. The first administrator is bound to a real customer division supplied by the operator at setup. See **Bootstrap Compatibility** |
| F-004 taxonomy-string-based legacy alias activation | MEDIUM | **Accepted in full.** The alias is gated on provenance lineage (`FRESH` never receives it), never on division or category names. See **Reporting Transition** |
| F-005 `instance_settings` / `business_actor_user_id` scope creep | MEDIUM | **Accepted in full.** Removed from P0-14 entirely. `findTrustedOwnerActorUser` behavior is preserved verbatim. See **Deferred Decisions** |
| F-006 capability flag retains division coupling | LOW | **Acknowledged.** `divisions.grants_system_authority` is now labelled explicitly TRANSITIONAL, with the review's Option 4 recorded as the long-term target and deferred. See **SYSTEM_ADMIN Transitional Model** |

Non-blocking review suggestions (formalize `presets/preset.schema.json`; register `check-first-admin-bootstrap.ts` in `check-migration-baseline.ts`) are folded into the P0-14 work items.

## Verified Current State

Verified by direct file inspection, not taken from the inventory summary. Where this section extends or corrects the inventory it is marked.

### Taxonomy storage is already configuration-shaped

- `public.divisions` and `public.roles` (`202608290001:14-30`): `code` unique with format check `^[A-Z][A-Z0-9_]*$`, `name`, `active`, timestamps. **No enum, no allowlist constraint on the code set.**
- `public.permissions` / `role_permissions` (`202608290001:31-45`): 23 product permissions granted to STAFF (6), ADMIN (9), OWNER (5). Verified: `user.manage`, `division.manage`, `role.manage`, `permission.manage`, `system_authority.manage` are granted to **no** role — governance is authority-gated, not role-gated.
- `division_collaboration_rules` (`202608290005:3-15`): directional, default-deny, `task_scope` constrained to `'ALL'`, partial unique index on active triples, `check (allowed or not requires_approval)`.
- `tasks.task_category` (`202609010003`): free-form nullable text, format-only regex, reporting index on `(owner_division_id, task_category)`. **No FK, no value constraint.**

The storage model does not need replacing. The problem is seed content, function bodies, and TypeScript constants.

### Seeds are idempotent and unconditional

`202608290001:123-141` inserts 9 divisions and 3 roles with `on conflict (code) do nothing`; `202608290005:29-41` inserts exactly one rule (`ONPAGE_B2C → CONTENT_CREATOR`) plus an audit row with `source = 'migration_seed'`. Re-running is safe, but every fresh install receives all of it.

### SYSTEM_ADMIN eligibility — five SQL sites, not four

1. `validate_system_admin_candidate` (`202608290003:80-96`) — **trigger** on `system_authority_assignments`, applies even to direct `service_role` writes. Requires `users.active AND divisions.code = 'IT'`.
2. `assign_system_admin` (`202608290003:281-289`) — same predicate, inside the `gwens_system_admin_invariant` advisory lock.
3. `update_user_access` (`202608290003:207-217`) — refuses to move the final active SYSTEM_ADMIN out of `'IT'` or to deactivate them.
4. **`protect_final_system_admin_user`** (`202608290003:98-122`) — trigger on `public.users`; blocks any update leaving the final SYSTEM_ADMIN inactive **or in a division whose code is not `'IT'`**. *(Extension: the inventory folded this into a line range; it is a distinct trigger and a distinct removal target.)*
5. `assert_it_system_admin` (`202609020001:56`) and `bootstrap_first_admin` (`202609090001:83-86,125-126`).

Application mirrors: `users.repository.ts:28`, `critical-alerts.routes.ts:23`, `admin-notifications.routes.ts:13`, `admin-user-management.routes.ts:55`, `integration-administration.service.ts:64`, `collaboration-rule-management.service.ts:66`, `telegram/it-console.ts:111`.

### `update_user_access` blocks customer-created divisions outright — the largest verified blocker

`202608290003:167-196`, read line by line:

```
if existing_user.legacy_telegram_user_id is null then raise 'Legacy compatibility mapping is required'
...
if public.legacy_division_value(target_division_code) is null then raise 'Division has no legacy compatibility mapping'
if public.legacy_role_value(target_role_code)     is null then raise 'Role has no legacy compatibility mapping'
```

**Extension / correction of the inventory.** The inventory reported that this function refuses *users* without a legacy id. It also refuses any *division or role code absent from the origin-company display dictionary*. A customer who creates a division today therefore cannot assign a single user to it. Taxonomy is not merely cosmetically hardcoded; **taxonomy creation is functionally useless until this function is replaced.**

The same function writes the legacy display columns:

```
update public.telegram_users set
  division = coalesce(public.legacy_division_value(target_division_code), 'UNASSIGNED'),
  role     = coalesce(public.legacy_role_value(target_role_code), 'UNASSIGNED'),
```

Note that today the dictionary is the *only* source for those columns; `divisions.name` is never consulted. That is the behavior F-002 correctly refused to let this ADR carry forward.

### Active users require a division and a role

`202608290002:12`: `check (not active or (division_id is not null and role_id is not null))`. A fresh install therefore cannot produce an active first administrator with zero divisions. This is the constraint that made the previous revision reach for a mandatory `ADMINISTRATION` division; **Bootstrap Compatibility** below satisfies it without inventing one.

### OWNER carries structural singleton semantics

`task-users.repository.ts:86-95` — `findTrustedOwnerActorUser` selects active users with `roles.code = 'OWNER'` and throws `503 OWNER_ACTOR_UNAVAILABLE` unless **exactly one** row is returned. `reporting.service.ts:54-56` gates reports on `actor.roleCode === "OWNER"`. `202609010004:189-190` gates alert acknowledgment on `roles.code = 'OWNER'` in SQL. No database constraint enforces the singleton; only the query does. This is a known limitation, and per F-005 it is **not** P0-14's problem to solve.

### Reporting is bound to one origin report

`reporting.service.ts:17-38` — the only report is `AFFILIATE_TASK_STATUS`, emitting literals `division: "CONTENT_CREATOR"` and `taskCategory: "AFFILIATE"`; `reporting.repository.ts:19` filters `.eq("task_category", "AFFILIATE")`. `src/tasks/types.ts:4` is `TASK_CATEGORIES = ["AFFILIATE"] as const`, enforced on every intake path.

### Checkers: one is safe, one is not

*Refinement of inventory item 7.* `scripts/check-governance-foundation.ts` parses the **migration file text**, so it stays valid forever against an immutable migration. `scripts/check-collaboration-schema.ts` mixes static text checks with **live database assertions** (`:30-32`): `LIVE_CONFIRMED_SEED` requires exactly the origin rule and `NO_SPECULATIVE_RULES` requires `rows.length === 1`. Any fresh install, and any customer that configures real rules, fails it. It must be split, following the P0-10 precedent (fresh runtime checker vs opt-in legacy business-data checker).

### `divisionId: 1` literal

`src/app.ts:108-118` contains a fallback access-state resolver hardcoding `divisionId: 1` / `roleId: 1`. Not on the production wiring path, but a positional-ID trap that must not survive.

## Problem Statement

Three requirements constrain any solution:

- **A.** A fresh commercial install must not present origin-company divisions, collaboration rules, categories, reports, or display-name mappings to the customer.
- **B.** The migrations that create that state are already applied to real instances and are immutable identities in the Supabase migration registry.
- **C.** No automated process may delete or reinterpret data because it *looks* like origin seed state. The adversarial review demonstrated that a dormant, staging, standby, or restored-but-unbootstrapped legacy database is indistinguishable at migration time from a brand-new one. Absence of rows is not evidence of a fresh install.

The naive resolutions all fail: editing the seeds breaks registry reconciliation (B); deleting by code match destroys the origin customer's live data (C); inferring intent from row counts destroys a dormant customer database (C); leaving the seeds in place ships another company's org chart to every customer (A).

## Goals

1. A fresh install completes onboarding with only customer-defined operational taxonomy, with no source edits and no manual SQL.
2. Historical migrations remain byte-identical.
3. Existing installations upgrade with zero deleted rows and zero behavior loss.
4. **No migration deletes or deactivates any operational row on any installation, ever.**
5. SYSTEM_ADMIN eligibility stops depending on the literal division code `IT`, without weakening trigger-level defense-in-depth.
6. Customers can create divisions and task categories and actually use them (`update_user_access` and intake validation must accept them).
7. No customer is forced to carry a division they did not ask for.
8. Reporting, collaboration rules, and categories operate over configurable taxonomy.
9. ICP presets are designed as data with a reviewable format, not implemented in P0-13.
10. P0-14 stays narrow enough to implement and review inside Phase 0.

## Non-Goals

Out of scope for P0-13 and P0-14:

- multi-tenancy or `tenant_id` (D-002);
- WhatsApp channel enablement (`202609010002:26` already reserves the value);
- ERP redesign or marketplace connectors (D-016);
- escalation preset engine;
- enterprise IAM/SSO (D-007);
- workflow builder or generic rules engine;
- self-service SaaS provisioning;
- full admin UI (Phase 3);
- white-label branding (D-012);
- making Warehouse B2B+C a core product requirement;
- notification-type/preference configurability (P2-01/P2-03);
- **business-actor/settings redesign, `instance_settings`, `approval.decide` redesign, OWNER-singleton replacement** (F-005 — see Deferred Decisions);
- **custom role creation and role→permission grant editing** (see Role Model);
- removing the legacy display-name dictionary functions (post-v1 contract stage);
- preset application tooling (format only in P0-13).

## Taxonomy Classification

| Layer | Contents | Disposition |
| --- | --- | --- |
| **1. Core schema** | `divisions`, `roles`, `permissions`, `role_permissions`, `users`, `system_authority_assignments`, `division_collaboration_rules`, `tasks.task_category` column + index, audit log, RLS/SECURITY DEFINER posture | Keep unchanged; extend additively |
| **2. Generic product defaults** | Roles `STAFF`, `ADMIN`, `OWNER` + their permission grants; the product permission catalog | Ship; reserve codes; see Role Model |
| **3. Customer configuration** | Divisions (including the first one, created at setup), task categories, collaboration rules | Created during onboarding, never by migration seed |
| **4. ICP presets** | Warehouse B2B+B2C and future bundles | Versioned JSON data applied through the management API. Never schema, never a migration |
| **5. Legacy compatibility** | `IT` capability carry-over, `legacy_division_value`/`legacy_role_value` as fallback, `UNASSIGNED` sentinel, `telegram_users` display columns, deprecated `AFFILIATE_TASK_STATUS` alias | Retained where lineage is not `FRESH`; retired in a later contract stage |
| **6. Origin-company state** | 8 origin divisions, `ONPAGE_B2C → CONTENT_CREATOR` rule, `AFFILIATE` category, origin dictionary content | Must not be visible to a fresh commercial customer |
| **7. Deferred** | See Non-Goals | Not touched |

The permission catalog stays **product-owned**. Customers compose from product permissions; they do not invent permissions, because application authorization must reason over a closed set.

## Desired Fresh-Install State

```
npm run migrate            -> core schema + product defaults; NOTHING deleted, NOTHING deactivated
npm run setup              -> operator declares a fresh commercial install:
                                - records positive provenance (FRESH)
                                - retires the historical starter seed (guarded, see below)
                                - creates the customer's FIRST REAL DIVISION (operator-supplied)
                                - creates the first administrator in it, grants SYSTEM_ADMIN
configure organization     -> divisions, users, collaboration rules, task categories
                              (optional ICP preset import)
connect Telegram           -> bot token, registration flow
go live
```

Between `migrate` and `setup` the historical seed rows are still present in the database. This is safe and deliberate: no user account exists, nobody can authenticate, no catalog is reachable by the customer, and `setup` retires the seed in the same transaction that creates the first administrator. **The customer never sees origin taxonomy.**

## Positive Install Provenance

Replaces the rejected heuristic classifier. The governing rule is stated first:

> **An installation is treated as LEGACY (non-destructive, legacy-compatible) unless a human operator has positively declared it a fresh commercial install through the clean-install workflow. UNKNOWN is LEGACY.**

### Storage

One migration-created table, **empty on every install until an operator writes it**:

```
public.installation_provenance (
  singleton smallint primary key default 1 check (singleton = 1),
  lineage text not null check (lineage in ('FRESH','LEGACY')),
  declared_at timestamptz not null default now(),
  declared_by text not null check (length(trim(declared_by)) > 0),   -- operator-supplied attribution
  declaration_source text not null,                                   -- e.g. 'setup_cli'
  evidence jsonb not null,                                            -- veto counters observed at declaration
  origin_seed_retired_at timestamptz,
  origin_seed_retired_count integer
)
```

Append-only: a `before update or delete` trigger raises unconditionally except for the single `update` that stamps `origin_seed_retired_at`/`origin_seed_retired_count` inside the same setup transaction. Lineage, once written, cannot be changed by any code path. Correcting a mistaken declaration requires a deliberate, audited, manually authorized forward migration — never a runtime action.

### Who writes it, and when

| Question | Answer |
| --- | --- |
| **Who writes it** | The human operator performing the installation, through the existing `npm run setup` CLI. Never a migration, never the application, never an automatic inference |
| **When** | After `npm run migrate`, at first-administrator provisioning, in the same database transaction as the bootstrap |
| **How the operator declares** | Interactive: setup prints the exact rows it proposes to retire and asks whether this is a new installation for a new customer. Non-interactive: exactly one of `--fresh-install` or `--keep-existing-taxonomy` is **required**; there is no default and no inferred answer |
| **Existing installs** | Never run fresh setup — `instance_bootstrap` already exists and setup refuses. Provenance stays absent, which reads as `UNKNOWN` ⇒ LEGACY. Operators may optionally record `LEGACY` explicitly with `npm run setup --record-legacy`; behavior is identical either way |
| **Re-runs** | The singleton primary key makes a second declaration a no-op with an explicit "already provisioned" message. `origin_seed_retired_at` makes retirement single-shot |
| **Migrations** | **Never read provenance.** Every migration behaves identically on every installation. Misclassification at migration time is therefore structurally impossible |
| **Application** | Reads provenance once at startup. Absent ⇒ `UNKNOWN`. Used for exactly one thing in P0-14: legacy report alias registration (see Reporting Transition) |

### Why an environment flag is not the authority

`--fresh-install` is a one-time **input** to a declaration, not the ongoing authority. The authority is the immutable `installation_provenance` row it creates. A stale or mistaken env var on a later deploy cannot retire anything, because provenance already exists and retirement is already stamped. The flag also cannot reach a legacy install at all, because setup refuses once `instance_bootstrap` exists.

### The role of row-count evidence

Row counts (`users`, `tasks`, `telegram_users`, `instance_bootstrap`, `system_authority_assignments`, non-seed `audit_logs`, extra/modified catalog rows) are still gathered — but their authority is inverted relative to the rejected design:

- previously: "all zero ⇒ this is FRESH ⇒ delete" (**authorization** — unsafe, F-001);
- now: "any non-zero ⇒ refuse retirement regardless of what the operator declared" (**veto** — fail-closed).

Evidence can only ever prevent a destructive action. It can never authorize one. A dormant legacy database therefore survives even if an operator wrongly declares it fresh, because its seed rows fail the identity/reference gates or the evidence veto fires — and even if every count were genuinely zero, deletion is limited to rows that are provably the untouched historical starter seed with zero references.

## Historical Migration Constraint

Historical migrations are immutable. Permitted in a new forward migration: `create table`, `alter table ... add column`, `create index`, `create or replace function` (replacing a function body is not an edit of history), `create trigger`, and **additive** data statements. Forbidden: editing, deleting, renaming, or re-timestamping any existing file in `supabase/migrations/`, and — new in this revision — **any `delete`, `truncate`, or `active = false` statement against operational rows in any migration, guarded or not.**

## Chosen Transition Strategy

**Non-destructive migrations + operator-authorized fresh provisioning.**

The work splits into two layers that never overlap.

### Layer 1 — Migrations: universal, additive, lineage-independent

Identical behavior on every installation. No deletes, no deactivations, no inference:

1. Create `installation_provenance` (empty) and `task_categories` (empty).
2. Add `divisions.grants_system_authority`, `divisions.provisioning_source`, `roles.system_managed`.
3. Add permission `alert.acknowledge`, granted to `OWNER` by default.
4. Mark `STAFF`/`ADMIN`/`OWNER` as reserved (`roles.system_managed = true`) — additive metadata only.
5. Set `grants_system_authority = true` on the division whose code is `IT` **if such a row exists**. On a database without `IT` this is a zero-row no-op. This is an *additive capability grant that preserves existing behavior*, not an inference about lineage, and it is the only place any origin code appears in P0-14 SQL.
6. Backfill `task_categories` from evidence: `insert ... select distinct task_category from tasks where task_category is not null`. A legacy install gets `AFFILIATE` automatically; a database with no tasks gets nothing. No literal appears.
7. Replace function bodies to use the capability predicate and to unblock `update_user_access` (order and compatibility in **Deploy Compatibility Matrix**).
8. Add integrity triggers (capability write-guard, last-capability-division guard, reserved-role guard, provenance append-only guard).

### Layer 2 — `npm run setup`: explicit, operator-authorized, once

On a database that has never been bootstrapped, with the operator's positive declaration, inside one transaction:

1. Write `installation_provenance` with the declared lineage.
2. If `FRESH`: retire the historical starter seed under the gates in **Seed Retirement Safety**.
3. If `FRESH`: create the customer's first real division from operator input (name, and code derived from it or supplied explicitly) — an ordinary, fully editable customer row.
4. Set `grants_system_authority = true` on that division through the privileged setter.
5. Create the first administrator in it with reserved role `ADMIN`, grant `SYSTEM_ADMIN`, write the singleton bootstrap marker and the audit record — all exactly as ADR P0-11 specified.

If the operator declares `--keep-existing-taxonomy`, steps 2–3 are skipped, lineage is recorded `LEGACY`, and the administrator is bound to an existing division the operator names. This is the correct path for staging clones and restored databases.

### Recovery path if retirement is skipped

Nothing is lost. After bootstrap, an administrator can delete each unreferenced origin division through the ordinary `DELETE /api/admin/divisions/:id` route — they are unreferenced, so the standard reference guard permits it. Setup-time retirement is a convenience that gives a clean first-run experience; it is not the only way to reach a clean taxonomy. This materially de-risks the whole mechanism.

## Fresh Install vs Upgrade Semantics

| Aspect | Declared `FRESH` | `LEGACY` / `UNKNOWN` (default) |
| --- | --- | --- |
| Migration behavior | Identical | Identical |
| Origin division rows | Retired at setup under three gates | Kept, untouched, forever |
| Origin collaboration rule | Retired at setup under the same gates | Kept and active |
| Capability-bearing division | The customer's first real division, operator-named, fully editable | Existing `IT`, flagged by migration; no rename, no new row |
| Task categories | Empty (no tasks existed to derive from) | Backfilled from real task data |
| Legacy display dictionary | Present, unreachable (no legacy rows) | Present, used as fallback only |
| `AFFILIATE_TASK_STATUS` alias | Never registered | Registered |
| Collaboration checker | Structural checks only | Structural + opt-in legacy origin-seed check |

One codebase, one migration chain, one migration behavior. The only branch is an operator-declared, immutably recorded provenance row consumed by setup and by one reporting registration.

## Seed Retirement Safety

Retirement happens **only** in `npm run setup`, **only** inside the bootstrap transaction, and **only** when all of the following hold. Any failure aborts the whole transaction — no partial retirement, no administrator created.

| # | Gate | Purpose |
| --- | --- | --- |
| 1 | Operator has positively declared `FRESH` for this installation (interactive confirmation or explicit `--fresh-install`) | Positive provenance. Nothing is ever inferred |
| 2 | `instance_bootstrap` is empty and `installation_provenance` is empty | The installation has never been provisioned; retirement is structurally one-shot |
| 3 | **Evidence veto**: zero rows in `users`, `telegram_users`, `tasks`, `system_authority_assignments`; zero `audit_logs` rows whose `source` is not `'migration_seed'` | Any sign of use overrides the operator's declaration. Evidence can only refuse, never permit |
| 4 | The row's `(code, name)` pair matches the historical `202608290001` starter pair exactly (e.g. `('GUDANG','Gudang')`), or the rule matches the exact `202608290005` pair | A customer row that reuses a code with a different name is never touched |
| 5 | Zero inbound references: no `users.division_id`, no `tasks.owner_division_id` / `requesting_division_id`, no `division_collaboration_rules` endpoint, no `audit_logs` reference | Fail-safe even if gates 1–4 were all somehow wrong |
| 6 | The proposed retirement list is printed to the operator before execution (interactive) or written to the log (non-interactive) | Human-visible, auditable |

Every retired row produces an `audit_logs` entry with `source = 'setup_origin_seed_retirement'`, and `origin_seed_retired_at` / `origin_seed_retired_count` are stamped.

Deletion — rather than deactivation — is chosen deliberately for the retired rows. Deactivating them would leave `divisions.code` occupied, and `GUDANG`, `MANAGEMENT`, `FINANCE`-adjacent codes are exactly the ones a real Indonesian small business will want for itself; a permanently reserved but invisible code is a worse trap than a deleted row. Deletion is safe here precisely because gate 5 proves nothing references the row and gate 3 proves the installation has never been used.

## Division Model

**Identity.** `divisions.id` is internal. `divisions.code` is the **external contract identifier** — n8n/CSV intake resolves `owner_division` by code (`task-ingestion.service.ts:92-106`), so under D-008 it is part of a published contract and is **immutable after creation**. `name` is the display label and is freely editable.

**New columns** (additive):

- `grants_system_authority boolean not null default false` — transitional SYSTEM_ADMIN eligibility capability;
- `provisioning_source text` — `'CUSTOMER' | 'PRESET' | 'SETUP'`, audit metadata only, never a deletion criterion, `null` on pre-existing rows.

There is **no `divisions.system_managed`** and no system-owned division on any install (F-003).

**Lifecycle.**

| Operation | Rule |
| --- | --- |
| create | Existing code regex + uniqueness. `grants_system_authority` is **forced false**; the API rejects it in the request body |
| rename | `name` only; a `code` change is rejected with `DIVISION_CODE_IMMUTABLE` |
| deactivate | Allowed unless it is the last active division with `grants_system_authority` |
| delete | Allowed when zero inbound references (users, tasks, collaboration rules, audit) and it is not the last capability-bearing division. Otherwise `409 DIVISION_IN_USE` with reference counts |
| historical data | FKs never change; tasks and users referencing a deactivated division stay valid and reportable |

Inactive divisions cannot be newly assigned (already enforced at `202608290003:175-177`) and cannot be added to a new collaboration rule. Existing rules touching an inactive division evaluate as **absent** — fail-closed, matching default-deny.

## Role Model

Scope deliberately reduced (required change 8). P0-14 changes role *coupling*, not role *management*.

| Question | v1 decision |
| --- | --- |
| Do STAFF/ADMIN/OWNER remain seeded generic defaults? | **Yes.** They are defensible product defaults and every existing install depends on them |
| Which codes are reserved? | `STAFF`, `ADMIN`, `OWNER` — marked `roles.system_managed = true`. `ADMIN` is required by `bootstrap_first_admin`; `OWNER` by `findTrustedOwnerActorUser` and the default grants; `STAFF` for symmetry. Codes immutable, rows not deletable, not deactivatable |
| Which fields may be edited in P0-14? | `name` only, on the three reserved roles. That is what "division/role management needed for non-technical operation" (PRD §5.7) requires when only three roles exist |
| Who manages role→permission grants? | Nobody, in P0-14. Governance permissions are granted to no role and grant editing is not exposed. Defaults ship as seeded |
| Custom role creation? | **Deferred to P3-03.** Three defaults are sufficient for v1 and adding role CRUD would introduce new privilege semantics for no taxonomy benefit |

**Permission-keyed authorization is kept** (the review's KEEP NOW): authorization stops keying on role *codes* so that a rename cannot change privilege. P0-14 adds one permission, `alert.acknowledge`, granted to `OWNER` by default, and replaces the `roles.code = 'OWNER'` checks in the alert acknowledgment guard (`202609010004:189`), `reporting.service.ts:assertOwner`, `critical-alert.service.ts`, and `task-actor.service.ts` with permission checks against the actor's granted set. Behavior on every existing install is bit-identical, because `OWNER` holds the grants.

**`findTrustedOwnerActorUser` is not touched** (F-005). The exactly-one-active-OWNER actor resolution stays exactly as it is today. Only the *authorization* decision made about the resolved actor becomes permission-keyed.

**PIC / Supervisor / Manager** are verified present only in the `ROLES` display enum (`src/types/index.ts:12`), with no seed, no grant, and no `mapLegacyRole` mapping. They are **migration-only legacy display values**: removed from the product enum and product-facing catalogs; still tolerated as opaque strings in `telegram_users.role` on legacy installs, where the reconciler reports them as "needs assignment" instead of failing.

## SYSTEM_ADMIN Transitional Model

**`divisions.grants_system_authority` is explicitly TRANSITIONAL.** It is adopted because it is the smallest change that removes the literal `'IT'` from five SQL sites and seven TypeScript sites while preserving the trigger-level guarantee that exists today. It is not the ideal long-term semantic model, and this ADR does not claim it is.

Eligibility becomes: **an active user whose division has `grants_system_authority = true`.**

Constraints this model must satisfy, all of which are met:

| Requirement | How it is met |
| --- | --- |
| No customer-facing CRUD may set it | Division create forces `false`; division PATCH rejects the field with `400`; a `before insert or update` trigger on `divisions` rejects any change not made inside the privileged setter (transaction-local marker via `set_config`/`current_setting`) |
| Only a privileged SECURITY DEFINER path may change it | `set_division_system_authority(p_division_id, p_enabled, p_actor_user_id, p_source)`, requiring an active SYSTEM_ADMIN actor, refusing to unset the last capability-bearing division, writing an audit row. Setup calls it once during bootstrap under the existing advisory lock |
| It must not require a dedicated system division | The capability is set on whichever real division the customer already has — `IT` on a legacy install, the operator-named first division on a fresh one. No product-owned division exists (F-003) |
| Existing IT admins remain valid during upgrade | The migration sets the capability on `IT` **before** replacing any function body, so eligibility is continuous with no window in which the predicate is false |
| A division named `IT` grants nothing | The code no longer appears in any predicate. Creation forces the flag false and the trigger blocks direct writes |
| Long-term removal may be deferred | Yes — see below |

**Acknowledged limitation (F-006).** Flagging a division makes every active user in it a valid `assign_system_admin` candidate. For a small business whose capability division is "Management" this is acceptable; it is strictly narrower than today, where the pool is "everyone in IT". It remains a coupling of org structure to system administration.

**Long-term target: the review's Option 4 — eligibility is "active user", with authorization enforced at the request layer.** That becomes correct once P1-01 delivers real request-level admin identity and signed sessions; until then the database trigger is the only enforcement point that survives a compromised route or a direct `service_role` write, and removing it would weaken security. Deferred to P1-01 (see Deferred Decisions). No new authority table is introduced in either direction.

**Function changes** (all `create or replace` in new migrations; historical files untouched):

| Function | Change |
| --- | --- |
| `validate_system_admin_candidate` | `divisions.code = 'IT'` → `divisions.grants_system_authority` |
| `assign_system_admin` | same substitution |
| `protect_final_system_admin_user` | "must remain in IT" → "must remain in a capability-bearing division" |
| `update_user_access` | same substitution, plus the legacy relaxations below |
| `assert_it_system_admin` | body replaced with the capability predicate; **name kept** per D-013 (it is an applied identifier), with a comment recording the semantic change |
| `bootstrap_first_admin` | see Bootstrap Compatibility |

**Application side.** All seven TypeScript IT-guards resolve one shared predicate — `actor.divisionGrantsSystemAuthority`, populated from the joined division row and implemented once in `src/auth/`. `countSystemAdminCandidates` filters on the capability. Test E asserts the SQL and TypeScript predicates agree on identical fixtures so they cannot silently diverge.

## Task Category Model

Retained unchanged from revision 1; the review assessed it **SOUND**.

```
public.task_categories (
  id bigint generated always as identity primary key,
  code text not null unique check (code ~ '^[A-Z][A-Z0-9_]{0,49}$'),
  name text not null check (length(trim(name)) > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)
```

The regex matches the existing `tasks.task_category` constraint exactly.

- **No foreign key** from `tasks.task_category`. An FK would require rewriting a live table and would reject historical values. The column stays free-form text; the catalog is the *validation* authority, not a referential one.
- **Write-side validation only**, in one shared validator replacing `TASK_CATEGORIES` across manual, CSV, and automation intake: if the active catalog is non-empty, the category must be an **active** catalog code or `null`; if the catalog is empty, the category must be `null`. Inactive categories block new writes.
- **Reads never validate.** Historical `AFFILIATE` tasks stay readable, listable, and reportable even after the category is deactivated or if it was never catalogued. Admin surfaces flag such values as "in use, not in catalog".
- **Migration of history:** evidence-derived backfill (`select distinct task_category from tasks`). Legacy installs get `AFFILIATE`; a fresh database gets nothing.
- **Customer management:** full CRUD; `code` immutable after creation; delete blocked when any task references the code — deactivate instead.
- **Fresh-install defaults: none.** Shipping a guessed default catalog would repeat the origin-taxonomy mistake in miniature.

No workflow engine, no per-category behavior, no state machines.

## Reporting Transition

`AFFILIATE_TASK_STATUS` becomes one parameterization of a generic report.

**Generic report `TASK_STATUS`** — parameters `divisionCode?` (null = all divisions the actor may view), `categoryCode?` (null = all), `window`, `statuses?`. The existing aggregation (open / in-progress / blocked / completed / overdue / upcoming / completion rate / excluded cancelled and draft) and drill-downs are preserved verbatim; only the filter predicate becomes parameterized. `reporting.repository.ts:findAffiliateTasks` becomes `findTasksForReport(filters, range)`, using the existing `(owner_division_id, task_category)` index.

**Legacy alias gating — corrected (F-004).** The deprecated id `AFFILIATE_TASK_STATUS` is registered **if and only if `installation_provenance.lineage` is not `FRESH`** — that is, on `LEGACY` and on `UNKNOWN` (provenance absent). It is never gated on the existence of a division named `CONTENT_CREATOR` or a category named `AFFILIATE`. A fresh e-commerce customer who legitimately creates a `CONTENT_CREATOR` division for social-media staff and an `AFFILIATE` category for influencer work gets the generic report and nothing else.

The fail-safe direction is correct: an existing install that never records provenance keeps its alias (`UNKNOWN` ⇒ available), and only an explicit `FRESH` declaration withholds it. When registered, the alias forwards to `TASK_STATUS` with `{division: CONTENT_CREATOR, category: AFFILIATE}` and returns the current response shape. It is removed at v1.1 with a CHANGELOG entry (P2-05).

Authorization moves from `roleCode === "OWNER"` to the `report.view_cross_division` permission; division-scoped reporting uses the already-seeded `report.view_division`.

## Collaboration Rule Model

The mechanism is sound and unchanged: directional, default-deny, active-unique per `(source, target, scope)`, `allowed or not requires_approval`.

Only the origin of rules changes:

- **Fresh default:** zero rules. Cross-division task operations are denied until configured; same-division work is unaffected. Fail-closed and documented as an onboarding step in P0-16.
- **No-rule behavior:** unchanged — absence means denial.
- **Inactive divisions:** a rule whose source or target is inactive is treated as absent (deny). Creating a rule referencing an inactive division is rejected with `DIVISION_INACTIVE`.
- **CRUD:** `src/routes/collaboration-rules.routes.ts` and `collaboration-rule-management.service.ts` are already data-driven; only the IT actor guard changes to the capability predicate. Added validation: both divisions exist and are active, source ≠ target, no duplicate active triple, `requires_approval` implies `allowed`.
- **Preset import:** optional, create-only, through the same service.
- **Checker split:** `check-collaboration-schema.ts` keeps its static structural assertions and **drops** `LIVE_CONFIRMED_SEED` / `NO_SPECULATIVE_RULES`; those move to the opt-in legacy business-data checker excluded from fresh release archives, exactly as P0-10 did for staged-cutover validation.

`task_scope` stays constrained to `'ALL'` (inventory open question 3 — answered: defer).

## ICP Preset Model

Presets are **data**, applied through the management API, never schema and never migrations.

**Format:** one versioned JSON document per preset at `presets/<preset-id>/<version>.json`, validated against a standalone `presets/preset.schema.json` (formalized as a P0-14 artifact per the review's non-blocking suggestion).

```jsonc
{
  "presetId": "warehouse-b2b-b2c",
  "version": "1.0.0",
  "schemaVersion": 1,
  "displayName": "Warehouse B2B + B2C",
  "divisions": [
    { "code": "GUDANG_STOK", "name": "Gudang & Stok" },
    { "code": "SALES_B2B",   "name": "Sales B2B" },
    { "code": "SALES_B2C",   "name": "Sales B2C / Marketplace" },
    { "code": "FINANCE",     "name": "Finance & Collection" },
    { "code": "LOGISTIK",    "name": "Delivery & Logistik" },
    { "code": "MANAJEMEN",   "name": "Management" }
  ],
  "taskCategories": [],
  "collaborationRules": [
    { "source": "SALES_B2B", "target": "GUDANG_STOK", "allowed": true, "requiresApproval": false }
  ]
}
```

Properties this buys: reviewable in a pull request as plain data; no embedded SQL; machine-validatable before application; editable by hand during onboarding; extensible to further presets.

**Application semantics** (designed here, tooling implemented after P0-14): `--dry-run` prints a diff; application is **create-only and idempotent** — an existing code is reported as a conflict and skipped, never overwritten; rules apply only after all divisions resolve; the import is one transaction; created rows are stamped `provisioning_source = 'PRESET'` and audited. Presets never touch roles, permissions, users, or system capabilities.

Warehouse B2B+B2C is a starting point, not a product requirement; nothing in core schema references any preset.

## Legacy Identity Transition

Expand/contract. Nothing is removed in P0-14.

### Precedence — corrected (F-002)

> **Normalized tables are the source of truth. The legacy display dictionary is a compatibility fallback, consulted only when no normalized row is available.**

`update_user_access` writes the legacy display columns as:

```sql
division = coalesce(division_row.name, public.legacy_division_value(target_division_code), 'UNASSIGNED')
role     = coalesce(role_row.name,     public.legacy_role_value(target_role_code),         'UNASSIGNED')
```

`divisions.name` and `roles.name` are `not null`, so whenever a normalized row is resolved the customer's current display name wins outright and the dictionary is never reached. Renaming `SHOPEE_LIVE` from "Shopee Live" to "Marketplace Streaming" now propagates to the Telegram display columns, which is the behavior a customer expects. The dictionary survives only for the case where no row resolves (`p_division_id`/`p_role_id` null), and the trailing `'UNASSIGNED'` preserves today's default exactly.

Because seed rows were created with the same names the dictionary returns, every existing install that has not renamed anything sees byte-identical values after the upgrade (test M).

### Other relaxations in the same replacement

1. The `legacy_telegram_user_id is null` rejection is **removed**; when a user has no legacy row the `telegram_users` update is skipped instead of raising. This unblocks the P0-11 bootstrap administrator and every future non-Telegram user.
2. The "division/role has no legacy compatibility mapping" rejections are **removed** — the blocker that makes customer-created divisions unusable today.
3. The final-SYSTEM_ADMIN guard switches from `'IT'` to the capability.

The duplicate dictionary copies in `202608290002` and `202608290003` are left untouched (inventory open question 6 — answered: leave them; both are applied, the new function calls the current definition, and consolidating adds blast radius for no behavioral gain).

**Legacy Telegram users** keep their rows, display columns, `legacy_telegram_user_id` links, and preference booleans. Reconciliation continues to run. The `UNASSIGNED` sentinel stays until legacy columns are retired post-v1.

**`src/app.ts:108-118`** literal-ID fallback resolver is deleted in Stage D — unreachable in production wiring, and an outright hazard once division 1 may not exist.

**Notification preference columns** are untouched; their origin-domain naming is P2-01/P2-03, not P0-14.

## Bootstrap Compatibility

ADR P0-11's eligibility rules, transaction shape, advisory lock, singleton marker, audit record, and error taxonomy are all preserved. Two things change, and no fake division is created (F-003).

**Chosen approach: option C — the first administrator is bound to the customer's first real division, supplied by the operator at setup.**

`npm run setup` gains one prompt (`--division-name`, with `--division-code` optional and otherwise derived from the name):

```
display name, email, password   (unchanged from P0-12)
first division name             (new)  e.g. "Management", "Sales", "HQ"
fresh-install declaration       (new)  interactive confirm, or --fresh-install / --keep-existing-taxonomy
```

Inside the existing bootstrap transaction, in order: write provenance → retire seed (if declared FRESH and all gates pass) → create the customer division (`provisioning_source = 'SETUP'`, fully editable, **not** system-managed) → `set_division_system_authority(...)` on it → create the administrator with reserved role `ADMIN` → grant `SYSTEM_ADMIN` → bootstrap marker → audit.

Why this over the alternatives:

- **A (system bootstrap identity state that is not customer taxonomy)** would require new user states, new nullable-division semantics, and changes to every consumer of `users.division_id`. Large surface for a one-time problem.
- **B (relax the active-user division constraint for SYSTEM_ADMIN users)** means weakening `202608290002:12`, an invariant that every downstream query, report, and routing path assumes. A weakened invariant is permanent; the bootstrap need is momentary.
- **C (chosen)** requires no schema-constraint change, no new user state, and no product-owned division. The division created is one the customer genuinely wants and fully owns from day one — they can rename it, and they can delete it once the capability and its users have moved elsewhere. The operator was already being prompted for three values; a fourth is not a burden, and it makes onboarding start from the customer's real org chart.

`bootstrap_first_admin` changes accordingly: the division is passed in (created in the same transaction) rather than looked up by literal code; the role lookup stays `roles.code = 'ADMIN'`, which is now a *product-reserved* role rather than origin taxonomy; `TAXONOMY_UNAVAILABLE` still raises when the reserved role is absent; the audit payload emits resolved codes instead of the hardcoded `'division_code','IT'`. The first administrator still never receives `OWNER`.

On a legacy install nothing about bootstrap matters — it already ran. After Stage C the bootstrap administrator becomes editable through `update_user_access` for the first time.

## Schema Changes Required

All additive. No column dropped, no constraint loosened, no table renamed, and **no migration statement deletes or deactivates an operational row**.

| # | Change | Stage |
| --- | --- | --- |
| 1 | `create table public.installation_provenance` (singleton, empty, append-only trigger) | A |
| 2 | `alter table public.divisions add column grants_system_authority boolean not null default false` | A |
| 3 | `alter table public.divisions add column provisioning_source text` (audit metadata) | A |
| 4 | `alter table public.roles add column system_managed boolean not null default false` | A |
| 5 | `create table public.task_categories` | A |
| 6 | `insert into public.permissions ('alert.acknowledge', …)` + grant to `OWNER` | A |
| 7 | Mark `STAFF`/`ADMIN`/`OWNER` as `system_managed = true` | A |
| 8 | `update public.divisions set grants_system_authority = true where code = 'IT'` — additive, zero-row no-op where absent | B |
| 9 | `set_division_system_authority()` + capability write-guard trigger on `divisions` | B |
| 10 | Last-capability-division guard trigger; reserved-role guard trigger | B |
| 11 | `create or replace`: `validate_system_admin_candidate`, `assign_system_admin`, `protect_final_system_admin_user`, `assert_it_system_admin`, `update_user_access`, alert acknowledgment guard | B |
| 12 | `create or replace bootstrap_first_admin` (division passed in; reserved-role lookup) | B |
| 13 | Evidence-derived `task_categories` backfill | C |

Removed from the previous revision: `installation_profile` heuristic classifier, `divisions.system_managed`, `public.instance_settings`, `business_actor_user_id`, the `ADMINISTRATION` division insert, and every guarded `delete` in a migration.

## Application Changes Required

| Area | Change |
| --- | --- |
| `src/cli/setup.ts` | Provenance declaration (interactive confirm or explicit flag), first-division prompt, gated seed retirement, capability assignment — all inside the existing bootstrap transaction |
| `src/auth/` | One shared `systemAdminCapability` predicate; seven IT-literal guards rewritten against it (`critical-alerts.routes`, `admin-notifications.routes`, `admin-user-management.routes`, `integration-administration.service`, `collaboration-rule-management.service`, `telegram/it-console`, `users.repository`) |
| `src/repositories/users.repository.ts` | `countSystemAdminCandidates` filters on the capability |
| `src/tasks/types.ts` | Delete `TASK_CATEGORIES`; category becomes a runtime-validated string |
| `src/tasks/task-validation.ts`, `src/ingestion/automation-validation.ts`, `src/services/task-ingestion.service.ts`, `src/services/task.service.ts` | One shared catalog-backed category validator (cached; invalidated on category writes) |
| `src/services/reporting.service.ts`, `src/repositories/reporting.repository.ts`, `src/reporting/types.ts` | Generic `TASK_STATUS` report; provenance-gated legacy alias; `assertOwner` → permission check |
| `src/services/critical-alert.service.ts`, `task-actor.service.ts` | OWNER literal → permission check (**actor resolution unchanged**) |
| `src/types/index.ts` | Remove origin division/role display enums and PIC/Supervisor/Manager |
| `src/identity/legacy-mapping.ts` | Kept as a compatibility adapter; consulted only as a fallback, never for validation |
| `src/app.ts` | Delete the `divisionId: 1` fallback resolver |
| `src/services/user-management.service.ts` + routes | Catalogs expose the capability flag; access update no longer requires legacy mapping |
| New services/routes | Division management, task category management, role rename, capability setter (below) |
| `scripts/check-collaboration-schema.ts` | Split structural vs legacy live assertions |
| `scripts/check-first-admin-bootstrap.ts`, `check-user-management.ts` | Assert the capability predicate rather than the `IT` literal; register the bootstrap checker in `check-migration-baseline.ts` |

`scripts/check-governance-foundation.ts` needs no change: it parses immutable migration text.

**Not changed in P0-14:** `task-users.repository.ts:findTrustedOwnerActorUser`, `instance_settings` (does not exist), approval semantics, role grant editing.

## API / Management Surface

Minimum P0-14 capability — service + repository + HTTP route, no UI:

| Surface | Endpoints |
| --- | --- |
| Divisions | `GET /api/admin/divisions`, `POST`, `PATCH /:id` (name, active), `DELETE /:id` (guarded) |
| Task categories | `GET /api/admin/task-categories`, `POST`, `PATCH /:id`, `DELETE /:id` (guarded) |
| Roles | `GET /api/admin/roles`, `PATCH /:id` (**name only**) |
| Collaboration rules | Existing routes retained; guard predicate updated; validation added |
| System authority | `POST /api/admin/system-authority/divisions/:id/capability` → `set_division_system_authority` |
| CLI | `npm run setup` extensions above; `npm run configure -- --preset <id> [--dry-run]` (format designed in P0-13; tooling after P0-14) |

All under `defineAdminRoutes` and registered in the security manifest, per P0-04.

Deferred to Phase 3: every UI screen (P3-03), custom role creation, role grant editing, bulk operations, preset browsing.

## Migration Phases

| Stage | Content | Destructive? |
| --- | --- | --- |
| **A — Expand schema** | Provenance table (empty), `task_categories` (empty), `divisions.grants_system_authority`, `divisions.provisioning_source`, `roles.system_managed`, `alert.acknowledge` permission + OWNER grant, reserved-role marking | No |
| **B — Compatibility adapters** | Capability set on `IT` where present (**before** any function replacement), privileged setter, guard triggers, all `create or replace` function bodies | No |
| **C — Migrate existing state** | Evidence-derived `task_categories` backfill | No |
| **D — Application reads/writes** | New app activated: shared capability predicate, catalog-backed category validation, generic report, provenance-gated alias, permission-keyed authorization, `app.ts` literal removed | No |
| **E — Fresh-install provisioning** | `npm run setup`: provenance declaration, gated seed retirement, first customer division, capability assignment, first administrator. **The only place in the product where retirement can occur, and only by explicit operator declaration** | Yes — operator-authorized, six-gate, one-shot |
| **F — Retire compile-time assumptions** | Later release: remove the legacy report alias (v1.1), reassess the legacy dictionary once no legacy-only users remain | No |

Stages A–C are migrations, D is a release activation, E is an operator command, F is a future release.

## Deploy Compatibility Matrix

The existing release flow (P0-08) is: run migrations against the live database → then activate the new release. There is therefore a window in which **new schema serves the old application**. Every stage must be safe in that window.

| Schema State | App Version | Supported? | Reason |
| --- | --- | :---: | --- |
| Old schema | Old app | **Yes** | Current production state; unchanged |
| Old schema | New app | **No** | Not a supported ordering — the deploy gate runs migrations before activation and blocks activation on migration failure. New app reads `grants_system_authority`, `task_categories`, and `installation_provenance`, which do not exist yet |
| **New schema (Stage A)** | **Old app** | **Yes** | Purely additive. New columns have defaults and are never named by old queries (repositories use explicit column lists). New tables are unreferenced. The new `alert.acknowledge` permission is inert until a guard reads it |
| **New schema (Stage B)** | **Old app** | **Yes** | Every replaced function keeps its **exact signature**, so no old caller breaks. Behavior per function: `assign_system_admin` / `validate_system_admin_candidate` / `protect_final_system_admin_user` — on a legacy install `IT` was flagged earlier in the same migration, so an old caller passing an `IT` user still passes; on an install without `IT` there are no callers yet. `update_user_access` — strictly more permissive than before; every previously-accepted call is still accepted. Alert acknowledgment guard — `OWNER` holds `alert.acknowledge` by seed, so an old caller with an OWNER actor still passes. `assert_it_system_admin` — same predicate outcome on any install where `IT` exists |
| **New schema (Stage B)** | **Old setup CLI** | **Yes, with a stated caveat** | `bootstrap_first_admin` keeps its signature but now requires a capability-bearing division. On a legacy install `IT` carries it, so an old, not-yet-bootstrapped legacy database still bootstraps. On a brand-new database no division carries it, so an old setup CLI raises `TAXONOMY_UNAVAILABLE` with zero writes — a fresh install is always performed with the matching release, so this ordering does not occur in practice, and it fails closed rather than creating bad state |
| **New schema (Stage C)** | **Old app** | **Yes** | `task_categories` is populated but only the new app reads it. The old app keeps validating against its compiled `["AFFILIATE"]`, which is a subset of the backfilled catalog on a legacy install — no write the old app accepts would be rejected by the new rules |
| New schema | New app | **Yes** | Target state |
| New schema + provenance declared FRESH | New app | **Yes** | Fresh commercial install |

Rules this imposes on P0-14 implementation:

1. **No function signature may change before new-app activation.** `create or replace` is permitted only where every existing caller stays valid — verified above for all seven replaced functions.
2. **No column may be dropped, renamed, or made `not null` without a default** in Stages A–C.
3. **Capability assignment on `IT` must land in the same migration as, and before, the function replacements** that depend on it.
4. **No migration may delete or deactivate an operational row**, so an aborted deploy leaves nothing to restore.

## Security Model

Database-level constraints remain authoritative:

- `divisions.code` / `roles.code` / `task_categories.code`: unique and format-checked. Uniqueness alone blocks a second `OWNER` role or `IT` division.
- Reserved roles: `roles.system_managed = true` blocks delete, code change, and deactivation via trigger, not merely in application code.
- `grants_system_authority`: writable only through the SECURITY DEFINER setter requiring an active SYSTEM_ADMIN; direct writes rejected by trigger; creation forces `false`; the last capability-bearing division cannot be deleted, deactivated, or unset.
- SYSTEM_ADMIN candidacy stays enforced by a **trigger**, so it holds against direct `service_role` writes — the property that made the original design defensible is preserved.
- `installation_provenance` is append-only by trigger; lineage cannot be rewritten by any runtime path.
- Retirement is impossible outside the setup transaction, impossible after bootstrap, impossible without an explicit operator declaration, and impossible against any referenced or non-identical row.
- Collaboration rules: existing checks plus active-division validation; absence means denial.
- Foreign keys unchanged; deletion is guarded by reference counting, never by cascade.
- RLS deny-all, service-role-only access, `search_path = ''`, and SECURITY DEFINER hardening apply unchanged to every new object.
- Authorization keys on permissions, so renaming a role cannot change privilege.

## Failure Scenario Matrix

| Scenario | Expected Behavior | Protection |
| --- | --- | --- |
| Dormant/staging legacy database is migrated | Nothing is deleted or deactivated; no classification occurs; install remains fully intact | Migrations are unconditionally non-destructive; provenance stays absent ⇒ LEGACY |
| Operator wrongly declares a dormant legacy database `--fresh-install` | Retirement refused; transaction aborts; nothing deleted | Evidence veto (gate 3) fires on any user/task/telegram/authority/non-seed-audit row; gates 4–5 refuse referenced or renamed rows |
| Restored backup of an origin database is re-migrated | Identical to production; no deletes | Same as above; `instance_bootstrap` present ⇒ setup refuses |
| Someone deletes all users then re-runs migrations hoping to trigger cleanup | No effect — migrations never retire anything, and setup refuses once `instance_bootstrap` exists | Migration/provisioning separation; one-shot stamps |
| Stale `--fresh-install` env value on a later deploy | No effect | Retirement lives in setup, not migrate; provenance already exists; retirement already stamped |
| Customer deletes a division referenced by tasks | `409 DIVISION_IN_USE` with reference counts; suggests deactivate | Reference count check + FK; no cascade |
| Customer deletes the last capability-bearing division | `409 SYSTEM_AUTHORITY_DIVISION_REQUIRED` | Last-capability guard trigger |
| Customer renames a reserved role | Display name changes; privilege unchanged | Permission-keyed authorization; `code` immutable on `system_managed` rows |
| Customer deletes a reserved role | `409 ROLE_RESERVED` | Reserved-role trigger |
| Attacker creates a role named `OWNER` | Rejected | `roles.code` unique index |
| Attacker creates a division named `IT` | Row created with `grants_system_authority = false`; grants nothing | The code appears in no predicate; creation forces the flag false |
| Attacker PATCHes a division with `grants_system_authority: true` | `400` forbidden field; a direct write is also rejected | Route allowlist + capability write-guard trigger |
| Attacker calls `assign_system_admin` for a user outside a capability division | Raises `SYSTEM_ADMIN candidate must be in a capability-bearing division` | Trigger + function, replaced consistently |
| Fresh customer creates division `CONTENT_CREATOR` and category `AFFILIATE` | Generic reporting only; the legacy alias is never registered | Alias gated on provenance lineage, never on taxonomy strings (F-004) |
| Customer renames a division that has legacy Telegram users | New name propagates to legacy display columns | `coalesce(division_row.name, …)` — normalized row wins (F-002) |
| Inactive division still named in a collaboration rule | Rule treated as absent → deny | Evaluator joins on `divisions.active`; API rejects new rules on inactive divisions |
| Category deleted while historical tasks reference it | `409 CATEGORY_IN_USE`; deactivate permitted | Reference count check; no FK to break history |
| Task read with an uncatalogued category | Returns and reports normally, flagged "not in catalog" | Validation is write-side only |
| Legacy Telegram mapping used for escalation | Impossible — legacy values map only to display columns, never to authority | Authority lives in `system_authority_assignments`, gated by trigger |
| Preset import into populated taxonomy | Never overwrites; conflicting codes reported and skipped | Create-only, transactional, dry-run first |
| Concurrent taxonomy creation with the same code | One succeeds, the other gets `409 CODE_EXISTS` | Unique index; no read-then-write race |
| Concurrent SYSTEM_ADMIN capability changes | Serialized | Existing `gwens_system_admin_invariant` advisory lock reused |
| Deploy aborts between migration and activation | Old app keeps running against new schema | Deploy Compatibility Matrix rows 3–6 |

## Fresh Install Simulation

**Customer:** a small online shop. Real divisions: `SALES`, `WAREHOUSE`, `FINANCE`. No IT department. No Administration department. No affiliate programme.

**1. `npm run migrate`** — schema created; historical seeds present but unreachable (no user account exists, no authentication is possible); `installation_provenance` empty; `task_categories` empty (no tasks to derive from); no division carries `grants_system_authority` (there is no `IT` row on a clean database, so migration step 8 is a zero-row no-op).

**2. `npm run setup`** — the operator supplies display name, email, password, and the first division name `Management`. Setup lists the nine seed divisions and the one seed rule as retirement candidates and asks whether this is a new installation for a new customer. The operator confirms. In one transaction: provenance `FRESH` recorded → all nine divisions and the one rule pass gates 3–5 and are deleted with audit rows → division `MANAGEMENT` / "Management" created (`provisioning_source = 'SETUP'`, fully editable, not system-managed) → capability set on it → administrator created with role `ADMIN` → `SYSTEM_ADMIN` granted → bootstrap marker written.

**State after migration, before onboarding:** no origin-company taxonomy is visible to anyone; there is no `ADMINISTRATION` division and no system-owned division of any kind; the bootstrap path is available and succeeds without an `IT` division.

**3. Onboarding** — the administrator creates `SALES`, `WAREHOUSE`, `FINANCE` through `POST /api/admin/divisions`; assigns users to them through `update_user_access` (which no longer consults the legacy dictionary for validation); optionally creates task categories or leaves the catalog empty; configures cross-division rules such as `SALES → WAREHOUSE`.

**End state:** divisions are `MANAGEMENT`, `SALES`, `WAREHOUSE`, `FINANCE` — all customer-owned and renameable, `MANAGEMENT` deletable once the capability and its users move elsewhere. Roles are the three generic product defaults. Categories are whatever the customer chose, or none. Reports are the generic `TASK_STATUS`; `AFFILIATE_TASK_STATUS` does not exist on this install. No occurrence of `Purchasing`, `Sales Grosir`, `Digital Marketing`, `Content Creator`, `On Page / B2C`, `Shopee Live`, `Gudang`, `Management` (as origin seed), `IT`, or `AFFILIATE` appears in any catalog, dropdown, or API response. Arbitrary divisions and arbitrary categories work end to end. No source file was edited and no SQL was run by hand.

## Existing Install Simulation

**Customer:** the origin installation — divisions including `IT` and `CONTENT_CREATOR`, tasks categorized `AFFILIATE`, an active `SYSTEM_ADMIN`, Telegram-mapped users, and the `ONPAGE_B2C → CONTENT_CREATOR` collaboration rule.

**1. Migration (Stages A–C).** Additive columns and tables appear. `IT` receives `grants_system_authority = true` before any function body is replaced, so the existing SYSTEM_ADMIN is continuously eligible with no gap. `task_categories` is backfilled to `{AFFILIATE}` from real task rows. **Zero rows deleted, zero deactivated, zero renamed.** Provenance remains absent ⇒ `UNKNOWN` ⇒ every legacy compatibility behavior stays on.

**2. Between migration and activation.** The old application keeps running against the new schema: every replaced function has an unchanged signature, the `IT` user still satisfies the capability predicate, `update_user_access` is strictly more permissive, and the old compiled `["AFFILIATE"]` validation is a subset of the backfilled catalog.

**3. After activation.**

- Existing SYSTEM_ADMIN remains authorized; all seven application guards now resolve the capability, which `IT` carries.
- Historical `AFFILIATE` tasks remain readable, listable, and reportable — the column was never constrained and reads are never validated.
- Telegram mapping continues to work; legacy users keep their rows and preferences; `update_user_access` now succeeds for both legacy Telegram users **and** the non-Telegram bootstrap administrator, which was previously impossible.
- `AFFILIATE_TASK_STATUS` remains available because lineage is not `FRESH`, and returns the same response shape as before.
- If an administrator renames `SHOPEE_LIVE` to "Marketplace Streaming", that name — from the normalized row — is what propagates to the legacy display column. The compiled dictionary no longer overrides it.
- The origin collaboration rule is untouched and still evaluates.
- No source edits, no manual SQL, no downtime beyond the normal release restart.

**4. Optional.** The operator may record `LEGACY` provenance explicitly for clarity; behavior is identical with or without it.

## Test Plan for P0-14

| Ref | Test | Notes |
| --- | --- | --- |
| A | All migrations apply cleanly to an empty PostgreSQL, in order, twice | Extends P1-09; the second run is a no-op |
| B | Fresh install after `migrate` **and** `setup --fresh-install` exposes no origin taxonomy | Divisions contain exactly the operator-named first division; zero collaboration rules; zero task categories; catalogs contain no origin code |
| C | Origin-style fixture upgrades with zero loss | Seed 9 divisions + users + tasks + the origin rule, run P0-14 migrations, assert every row survives byte-identically |
| D | Foreign keys remain valid post-upgrade | No orphan `users.division_id`, `tasks.owner_division_id`, `requesting_division_id`, or rule endpoints |
| E | SYSTEM_ADMIN no longer requires literal `IT` | Assign SYSTEM_ADMIN in a customer-created capability division; assert the SQL and TypeScript predicates agree on identical fixtures |
| F | Existing SYSTEM_ADMIN stays valid across the upgrade | Continuous eligibility; no window where the predicate is false |
| G | Bootstrap succeeds with no `IT` division and creates no system-owned division | Assert the first division is the operator-supplied one, `system_managed` does not exist on divisions, role is `ADMIN`, no `OWNER` |
| H | Customer creates an arbitrary division and assigns a user to it | Must exercise `update_user_access` — the current blocker |
| I | Customer creates and uses an arbitrary task category end to end | Manual, CSV, and automation intake |
| J | Historical `AFFILIATE` task remains readable and reportable | Including after the category is deactivated |
| K | Generic report over arbitrary division/category | Plus: alias absent under `FRESH`, present under `LEGACY` and under `UNKNOWN` |
| L | Collaboration rules work with arbitrary divisions | Plus: inactive-division rule denies |
| M | Legacy Telegram-mapped users still resolve; display values byte-identical before/after upgrade | Plus rename propagation: renaming a division updates the legacy display column (F-002 regression test) |
| N | Bootstrap admin with no Telegram identity can be managed | Closes the P0-11 limitation |
| O | No historical migration modified | CI checksums every file in `supabase/migrations/` |
| P | RLS / SECURITY DEFINER posture preserved | New tables deny-all; new functions `search_path = ''`; `check-schema`/`check-secrets` green |
| Q | Clean package/install works with no manual SQL | Fresh runtime checker green with zero origin data |
| R | **No migration deletes or deactivates anything** | Static assertion over all P0-14 migration files (no `delete`/`truncate`/`active = false` against operational tables) plus a row-count diff across a dormant-seeded fixture |
| S | **Dormant legacy database survives a wrong declaration** | Seed origin divisions + one telegram_user, run `setup --fresh-install`, assert retirement refused, transaction aborted, zero rows deleted |
| T | **Retirement is one-shot and gate-complete** | After a successful fresh setup, re-running setup is a no-op; each of gates 3, 4, 5 independently blocks retirement when violated |
| U | **Provenance is append-only** | Direct `update`/`delete` on `installation_provenance` raises; lineage cannot be rewritten |
| V | Capability write-guard | Direct update of `grants_system_authority` outside the setter is rejected; last-capability removal rejected; division create with the field in the body returns `400` |
| W | **Old app + new schema** | Run the previous release's test suite against the migrated schema; all seven replaced functions accept every previously valid call |

Test-fixture policy: fixtures define taxonomy through one shared catalog helper rather than string literals, and assertions are capability-first (`grantsSystemAuthority`, permission codes) rather than code-first. `tests/user-management/user-management.test.ts` parses migration SQL for grants; that stays valid because `202608290001` is immutable, and the new `alert.acknowledge` grant gets its own assertion against the new migration.

## Rollout / Upgrade Plan

1. Merge P0-14 migrations and application changes together; the deploy gate already runs `npm run migrate` before activation (P0-08).
2. Before touching the origin instance: resolve open question 1 with a read-only check, take a fresh backup, and rehearse the restore.
3. Stage the upgrade against a **restored copy** of the origin database first. Assert: zero deleted rows, `IT` capability set, existing SYSTEM_ADMIN continuously eligible, `telegram_users` display values byte-identical, `task_categories = {AFFILIATE}`.
4. Run the previous release's test suite against that migrated copy (test W) to prove the old-app window.
5. Deploy. Migration failure prevents activation; the release symlink does not move.
6. Post-deploy: confirm every existing SYSTEM_ADMIN resolves, run the opt-in legacy checker, and optionally record `LEGACY` provenance.
7. Fresh customers follow the P0-16 install guide: `migrate` → `setup` (declare fresh, supply first division) → configure → go live.

## Rollback Limitations

- Database migrations are forward-only (D-014, `AI_HANDOFF.md`). Application rollback selects a previous release; it does not reverse schema.
- **Migrations are now fully reversible in effect**, because they delete and deactivate nothing. Rolling the application back while the new columns, tables, and function bodies remain is safe: old code never reads the new columns, and every replaced function keeps its signature and accepts every previously valid call (see the Deploy Compatibility Matrix). This is a direct improvement over the previous revision, where a migration could delete rows.
- The only irreversible action in P0-14 is setup-time seed retirement, which is operator-declared, printed before execution, gated six ways, restricted to provably unreferenced rows on a never-provisioned installation, and audited. Should it ever need undoing, the rows are origin-company data a commercial customer must not have; restoring an equivalent starting taxonomy is a preset import.
- `installation_provenance` is append-only. Correcting a mistaken declaration requires a deliberate, audited, manually authorized forward migration — never a runtime action.

## Rejected Alternatives

1. **Heuristic install lineage classified from row counts at migration time.** Explicitly rejected (F-001). A dormant, staging, standby, or restored-but-unbootstrapped legacy database presents identically to a new one, so the classifier would authorize deletion of a real customer's taxonomy. Absence of rows is not evidence of a fresh install. Replaced by positive operator-declared provenance, with row-count evidence demoted to a veto that can only refuse.
2. **A mandatory `ADMINISTRATION` (or any system-managed) division.** Explicitly rejected (F-003). It replaces one imposed org-chart entry with another and forces a two-person shop to explain an "Administration department" it does not have, violating PRD §2.7. Replaced by binding the first administrator to a real customer division supplied at setup.
3. **Activating the `AFFILIATE_TASK_STATUS` alias from taxonomy strings** (`CONTENT_CREATOR` + `AFFILIATE` existing). Explicitly rejected (F-004). A fresh customer may legitimately use both words. Feature availability must never depend on string coincidence in customer data. Replaced by provenance-lineage gating.
4. **`instance_settings.business_actor_user_id`, `approval.decide` redesign, and OWNER-singleton replacement in P0-14.** Explicitly rejected (F-005) as scope creep: a new settings table, new routes, and an approval-semantics change, none of which taxonomy configurability requires. Deferred to P2-01; current OWNER actor behavior is preserved verbatim.
5. **`coalesce(legacy_division_value(code), division_row.name)`.** Rejected (F-002): the compiled dictionary would silently override every customer rename. Inverted so the normalized row wins.
6. **Editing or deleting the historical seed migrations.** Changes applied-migration identities, breaks the registry reconciliation established after the P0-12 incident, violates D-013/D-014.
7. **Unconditional delete by origin code.** Destroys the origin customer's live taxonomy; violates the "no destructive origin-code matching" constraint.
8. **Squashed fresh-install baseline.** Two divergent migration chains the Supabase CLI registry cannot reconcile; unacceptable risk so soon after P0-12.
9. **Deactivating rather than deleting retired seeds.** Leaves `divisions.code` permanently occupied by invisible rows — and `GUDANG`, `FINANCE`, `MANAGEMENT` are exactly the codes a real customer wants. A reserved-but-invisible code is a worse trap than a guarded deletion.
10. **Relaxing the active-user division constraint for bootstrap (option B).** Permanently weakens an invariant every downstream query assumes, to solve a momentary problem.
11. **A separate system bootstrap identity state (option A).** New user states and changes to every consumer of `users.division_id`; large surface for a one-time need.
12. **ADMIN role, or a dedicated eligibility table, as the SYSTEM_ADMIN predicate.** Role grants are (eventually) customer-editable and cannot be enforced in a trigger; a dedicated table is over-engineering the review also rejected.
13. **Dropping the eligibility predicate entirely today (Option 4).** Correct long-term, premature now: until P1-01 delivers request-level admin identity, the trigger is the only enforcement point surviving a compromised route or direct `service_role` write.
14. **A foreign key from `tasks.task_category` to `task_categories`.** Requires rewriting a live table and rejects historical values.
15. **Custom role creation and grant editing in P0-14.** New privilege semantics for no taxonomy benefit; deferred to P3-03.
16. **Per-category collaboration scopes now.** Unrelated to this transition; enlarges blast radius.

## Deferred Decisions

Recorded so they are not lost, and explicitly **not** P0-14 work:

| Item | Deferred to | Reason |
| --- | --- | --- |
| `instance_settings` singleton and runtime settings surface | P2-01 | Scope creep (F-005); taxonomy configurability does not need it |
| `business_actor_user_id` and the `findTrustedOwnerActorUser` singleton replacement | P2-01 | Same. Current behavior preserved verbatim in P0-14 |
| `approval.decide` semantics redesign | P2-01 / Phase 3 | Not a taxonomy concern |
| Retiring `divisions.grants_system_authority` for user-level eligibility (review Option 4) | P1-01 | Needs real request-level admin identity before the DB trigger can be safely relaxed |
| Custom role creation, role deactivation, role→permission grant editing | P3-03 | Three seeded defaults suffice for v1; adding role CRUD adds privilege semantics |
| Notification type/preference catalog configurability | P2-01 / P2-03 | Storage works; naming is cosmetic for v1 |
| Removing the legacy display dictionary functions and `UNASSIGNED` sentinel | Post-v1 contract stage | Requires that no legacy-only Telegram users remain |
| Removing the `AFFILIATE_TASK_STATUS` alias | v1.1 | Needs a CHANGELOG deprecation cycle (P2-05) |
| Widening `division_collaboration_rules.task_scope` beyond `'ALL'` | Post-v1 | Not required by any current customer need |
| Preset application tooling (`npm run configure`) | After P0-14 | Format is designed here; tooling is additive |
| Consolidating the duplicate legacy dictionary copies | Post-v1 | Both are applied and immutable; consolidation adds blast radius for no behavioral gain |

## Open Questions

Genuine blockers only.

1. **Live reference verification on the origin instance.** Which division ids are actually referenced by `users`, `tasks`, `division_collaboration_rules`, and `audit_logs` on the production origin database? Not answerable from this repository; a read-only check is required before the upgrade rehearsal is declared complete. It does **not** block writing P0-14 code, because no migration deletes anything on any install.
2. **External automation contract impact.** Do any live n8n automations submit `owner_division` codes or `task_category = AFFILIATE`? Nothing breaks on the origin install under this design (codes survive; `AFFILIATE` is backfilled into the catalog), but the answer determines whether the category validator needs a temporary permissive mode for other installs. Needs a contract-impact review with the automation owner.

Resolved in this revision and no longer open: the reserved fresh-install division code (there is none — the operator names the first division); the OWNER singleton (deferred, behavior preserved); duplicate legacy dictionary copies (leave untouched); `task_scope` widening (defer).

## Acceptance Criteria

P0-13 is complete when this revision is accepted. P0-14 is complete when:

1. No file under `supabase/migrations/` predating P0-14 differs by a single byte (CI checksum, test O).
2. **No P0-14 migration contains a `delete`, `truncate`, or deactivation against an operational row, proven statically and by row-count diff on a dormant-seeded fixture** (test R).
3. A dormant legacy database survives a wrongly declared `--fresh-install`: retirement refused, transaction aborted, zero rows deleted (test S).
4. `installation_provenance` is append-only and absent by default; every consumer treats absent as LEGACY (test U).
5. A fresh install after `migrate` + `setup --fresh-install` contains exactly the operator-named first division, the three reserved roles, the product permission catalog, zero collaboration rules, zero task categories, and no origin-company value anywhere (test B).
6. **No system-managed or product-owned division exists on any install**; `divisions.system_managed` does not exist (test G).
7. `npm run setup` completes on a database with no `IT` division and creates the first administrator in a customer-named division (test G).
8. An origin-style install upgrades with zero deleted rows, zero orphaned foreign keys, unchanged legacy display values, and a continuously valid SYSTEM_ADMIN (tests C, D, F, M).
9. Renaming a division propagates to the legacy display columns; the compiled dictionary never overrides a normalized row (test M).
10. SYSTEM_ADMIN eligibility is expressed by `divisions.grants_system_authority` in all five SQL sites and all seven TypeScript sites, and the two predicates are proven equivalent (test E).
11. The capability cannot be set outside the SECURITY DEFINER setter, and the last capability-bearing division cannot be removed (test V).
12. A customer can create a division and assign a user to it with no legacy Telegram mapping required (tests H, N).
13. A customer can create a task category and use it on every intake path, while historical `AFFILIATE` tasks remain readable and reportable (tests I, J).
14. The generic `TASK_STATUS` report works over arbitrary division/category, and the legacy alias is absent under `FRESH` and present under `LEGACY`/`UNKNOWN`, never gated on taxonomy strings (test K).
15. Collaboration rules function with arbitrary divisions, deny on inactive divisions, and no checker asserts origin seed state on a fresh install (tests L, Q).
16. The previous release's application runs correctly against the migrated schema (test W).
17. `presets/preset.schema.json` exists and validates the Warehouse B2B+B2C sample; no preset content appears in any migration.
18. `instance_settings`, `business_actor_user_id`, custom role creation, and role grant editing are **absent** from the P0-14 diff.
19. RLS/SECURITY DEFINER posture unchanged; typecheck, tests, secret scan, and schema checkers green; `check-first-admin-bootstrap.ts` registered in `check-migration-baseline.ts` (test P).
20. `ROADMAP.md`, `AI_HANDOFF.md`, and `DECISIONS.md` record the transition; origin-company documentation cleanup remains P0-15.
