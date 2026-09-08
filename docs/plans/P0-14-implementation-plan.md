# P0-14 Implementation Plan — Customer-Owned Taxonomy Transition

## Architecture Reconciliation Status

**READY**

**P0-14 MAY PROCEED TO IMPLEMENTATION.**

All six architecture inconsistencies raised by the first draft of this plan are resolved. Every resolution is recorded as **R-001 … R-006** in `docs/adr/P0-13-taxonomy-transition.md` (Status section) and applied throughout that ADR; the reconciled decisions are restated in **Reconciled architecture decisions** below and are binding on this plan. The ADR status is now **Accepted for P0-14 Implementation**.

Reconciliation changed six things in this plan: the setup RPC is a distinctly named function rather than an overload (R-001); the old-CLI-on-fresh-schema claim is corrected (R-002); the destructive-SQL rule is about execution rather than text (R-003); the audit gate permits exactly the one historical `migration_seed` row (R-004); the capability write-guard uses an owner `current_user` check rather than a `set_config` marker (R-005); and provenance stores no operator identity (R-006). Two ordering corrections follow: retire seeds **before** creating the first customer division, and scope the last-capability guard to post-bootstrap state.

Three stop conditions from the previous draft are now **eliminated by design rather than deferred to testing**: PostgREST overload ambiguity (no overload exists), the owner-executed capability path (`current_user` check is testable on any disposable PostgreSQL), and the impossible zero-audit retirement gate.

## Status and scope

Planning artifact only. This document translates the accepted P0-13 transition into an executable P0-14 sequence. It does not authorize live Supabase access, production data changes, deployment, VPS work, historical migration edits, sessions, UI work, custom roles, grant editing, presets application, or origin-documentation cleanup.

P0-14 is implemented from a clean branch. The architecture gate is closed; the remaining gates are the stop conditions at the end of this document, which are implementation-evidence gates rather than design questions.

## Verified baseline

Verified at repository commit `f1cf6f1` on branch `main`.

- Migration count: **14** tracked forward migrations.
- Latest migration: `supabase/migrations/202609090001_create_first_admin_bootstrap.sql`.
- Historical migration hashes were captured with `git hash-object`; P0-14 must preserve all 14 byte-for-byte.
- The current setup CLI accepts only `--name`, `--email`, and `--password-file`. It prompts for name/email as needed, checks bootstrap status before collecting a password, hashes in Node with scrypt, then makes one four-argument `bootstrap_first_admin` RPC call.
- Current bootstrap transaction resolves division code `IT` and role code `ADMIN`, creates a Telegram-less active user and credential, grants only `SYSTEM_ADMIN`, writes `instance_bootstrap`, writes one redacted audit row, and uses the historical `gwens_system_admin_invariant` advisory lock.
- `divisions` has `id`, `code`, `name`, `active`, and timestamps. Nine origin divisions are seeded by `202608290001`.
- `roles` has the same catalog shape. `STAFF`, `ADMIN`, and `OWNER` are seeded. There is no custom-role management.
- `tasks.task_category` is nullable text with the code-format check and reporting index; there is no category catalog or FK.
- Five current SQL authorization sites are taxonomy-coupled: `validate_system_admin_candidate`, `assign_system_admin`, `protect_final_system_admin_user`, `update_user_access`, and `assert_it_system_admin`. `bootstrap_first_admin` is a sixth SQL location with a literal `IT` lookup but is a bootstrap resolver rather than a reusable authorization predicate.
- Seven current TypeScript authorization/candidate sites are taxonomy-coupled: `users.repository.ts`, `admin-user-management.routes.ts`, `admin-notifications.routes.ts`, `critical-alerts.routes.ts` (admin evaluator), `integration-administration.service.ts`, `collaboration-rule-management.service.ts`, and `telegram/it-console.ts`.
- `TASK_CATEGORIES = ["AFFILIATE"]` currently reaches manual task route parsing, `TaskService`, CSV intake, automation intake, and their shared TypeScript types. Telegram task creation supplies `null`; ERP adapters normalize into the same intake and ultimately reach `TaskService`.
- Reporting exposes only `AFFILIATE_TASK_STATUS` at `/api/reports/content-creator/affiliate-task-status`, resolves `CONTENT_CREATOR`, filters category `AFFILIATE`, and checks `roleCode === "OWNER"`.
- Alert read/acknowledgment and trusted OWNER resolution also use OWNER literals. The database acknowledgment guard checks `roles.code = 'OWNER'`.
- `update_user_access` rejects users without a legacy Telegram link, rejects divisions/roles missing from compiled legacy dictionaries, and raises if the legacy row update finds nothing. It writes dictionary output rather than the normalized catalog display name.
- Collaboration rules are directional and default-deny. Existing HTTP support is list/create/patch; deactivation is a patch. Runtime lookup does not currently verify that both endpoint divisions remain active. The checker incorrectly requires exactly the origin `ONPAGE_B2C -> CONTENT_CREATOR` rule.
- Existing catalog repositories already read divisions/roles dynamically. Division create exists but is not exposed as a dedicated management surface; role writes do not exist.
- The centralized admin-key wrapper currently covers 11 route groups. New P0-14 admin routes must remain inside `defineAdminRoutes` and update the structural route manifest.

### Actual division inbound references

The repository contains more division foreign keys than the abbreviated ADR retirement list. Every physical delete check must cover all of these:

1. `users.division_id`.
2. `tasks.requesting_division_id`.
3. `tasks.owner_division_id`.
4. `division_collaboration_rules.source_division_id`.
5. `division_collaboration_rules.target_division_id`.
6. `task_source_integrations.requesting_division_id`.
7. `notification_routing_rules.owner_division_id`.
8. `critical_alerts.owner_division_id`.
9. Authority compatibility is indirect: active or historical `system_authority_assignments` attached to a user in the division, plus the last-capability invariant.
10. `audit_logs` has no division FK. Any audit-reference policy must therefore define exact `object_type`/`object_id` and JSON fields; it cannot be described as a relational inbound reference.

## Reconciled architecture decisions

The six inconsistencies this plan raised, and the decision now binding on implementation. Each is recorded identically in the ADR.

### R-001 — Bootstrap signature conflict

- **ADR statement (before):** every replaced function keeps its signature for old-app safety, *and* the customer division is "passed in" to `bootstrap_first_admin`.
- **Repository behavior:** `bootstrap_first_admin(p_display_name, p_email, p_password_algorithm, p_password_hash)`; `first-admin-bootstrap.repository.ts:124` calls it with those four named parameters through PostgREST.
- **Plan assumption:** add a named-parameter overload of the same function.
- **Why inconsistent:** the existing signature has no division or lineage parameter, so it cannot both stay unchanged and receive a division.
- **Risk if unresolved:** PostgREST resolves overloads by supplied argument-name set; a subset/superset pair is ambiguous (`PGRST203`) if the longer form carries defaults, and two same-named bodies complicate the R-003 destructive-SQL parser.
- **Chosen resolution:** **no overload.** `bootstrap_first_admin` keeps its exact four arguments; only its body changes, resolving the single active capability-bearing division and raising `TAXONOMY_UNAVAILABLE` on zero or more than one match — it never guesses and never creates, retires, or declares anything. A new, distinctly named `provision_first_installation(p_display_name, p_email, p_password_algorithm, p_password_hash, p_lineage, p_division_code, p_division_name)` owns the P0-14 path. Both delegate the identity/credential/authority steps to one internal helper, so there is a single implementation of first-administrator creation. Both are `SECURITY DEFINER`, pinned `search_path`, revoked from public/anon/authenticated, `service_role`-executable only.

### R-002 — Old CLI on a freshly migrated database

- **ADR statement (before):** on a brand-new database no division carries the capability, so an old setup CLI raises `TAXONOMY_UNAVAILABLE` with zero writes.
- **Repository behavior:** `202608290001` unconditionally seeds `IT`; the P0-14 migration flags it. `IT` therefore exists and is capability-bearing on every freshly migrated database.
- **Plan assumption:** the ADR claim is false and old-CLI fresh onboarding is unsafe.
- **Why inconsistent:** the ADR asserted a fail-closed outcome that cannot occur.
- **Risk if unresolved:** an acceptance test would be written against a behavior the database will never produce, and the real outcome — a silently legacy-shaped install — would go untested.
- **Chosen resolution:** **state the truth.** An old CLI against the new schema *succeeds* and places the administrator in `IT`, with provenance absent (`UNKNOWN` ⇒ legacy-compatible). Nothing is destroyed, no fake division is created; the install is legacy-shaped, not clean. The matching-release CLI is therefore **mandatory for commercial provisioning**, which the deploy flow already guarantees by activating the release before setup runs. Tests assert the old *runtime application* against the new schema; they assert the old *CLI* produces this documented legacy-shaped result rather than an error.

### R-003 — Destructive SQL in a migration file

- **ADR statement (before):** no migration may contain any `delete`, `truncate`, or `active = false` against operational rows, "guarded or not".
- **Repository behavior:** atomic retirement must run inside a database function, and functions are created by migrations.
- **Plan assumption:** `DELETE` text may appear inside the setup function body only.
- **Why inconsistent:** an absolute textual prohibition makes the required function uncreatable.
- **Risk if unresolved:** either the rule is quietly broken, or retirement is pushed outside a transaction and loses atomicity.
- **Chosen resolution:** the prohibition is on **execution**. No migration may *execute* a destructive statement when applied; destructive SQL may appear only inside the body of `provision_first_installation`, which no migration invokes. Enforced twice: statically (parse — destructive statements only inside that one named function, no top-level destructive DML) and behaviourally (apply to a fixture seeded with origin taxonomy, users, and tasks; assert every operational row count unchanged). Obfuscating SQL to satisfy the parser is a stop condition.

### R-004 — Immutable audit reference blocks retirement

- **ADR statement (before):** retirement gate 5 requires "no `audit_logs` reference".
- **Repository behavior:** `202608290005:41-55` writes a `COLLABORATION_RULE_CREATED` audit row with `source = 'migration_seed'`, `object_id` = the seed rule, and `after_state` JSON containing both candidate division ids.
- **Plan assumption:** permit exactly that historical record; treat any other audit evidence as a veto.
- **Why inconsistent:** the literal gate can never pass on any installation, so clean fresh retirement would be impossible.
- **Risk if unresolved:** fresh installs could never be cleaned, defeating the whole objective.
- **Chosen resolution:** `audit_logs` is append-only history, **not a relational reference**. Retirement checks the eight real division foreign keys (below). For audit, exactly one row may reference a candidate: the historical `COLLABORATION_RULE_CREATED` row with `source = 'migration_seed'`. Any other audit row referencing a candidate — by `object_type`/`object_id`, or by a division id inside `before_state`/`after_state` — is a veto. Retired rows keep their audit history; retirement writes its own audit rows.

### R-005 — Pre-admin privileged capability call

- **ADR statement (before):** the capability write-guard admits changes made "inside the privileged setter (transaction-local marker via `set_config`/`current_setting`)", and the setter requires an active SYSTEM_ADMIN.
- **Repository behavior:** setup must establish the first capability before any SYSTEM_ADMIN exists. Separately, `service_role` can call `set_config` for itself, so a marker is forgeable by exactly the principal the guard is meant to constrain.
- **Plan assumption:** an owner-executed path with a transaction-local bootstrap marker.
- **Why inconsistent:** the setter's precondition cannot hold during bootstrap, and the marker mechanism is not a real boundary.
- **Risk if unresolved:** either bootstrap cannot set the first capability, or the guard is weakened into decoration.
- **Chosen resolution:** the `before insert or update` trigger permits a change to `grants_system_authority` only when **`current_user` is the owner of `public.divisions`**. That is true inside owner-defined `SECURITY DEFINER` functions and false for any direct `service_role` write, and it cannot be forged with `set_config`. Two owner-defined entry points share one internal mutation routine: the public `set_division_system_authority` (requires an active SYSTEM_ADMIN) and `provision_first_installation` (reachable only before any bootstrap exists). The trigger is never weakened, and the check is directly testable on disposable PostgreSQL.

### R-006 — Operator attribution versus data minimisation

- **ADR statement (before):** `installation_provenance.declared_by text not null`.
- **Repository behavior:** the bootstrap audit row already records accountable installation context, sanitized.
- **Plan assumption:** omit personal attribution.
- **Why inconsistent:** a mandatory free-text operator field invites PII into a table that never needs it.
- **Risk if unresolved:** email or personal names land in a permanently immutable row, conflicting with the redaction posture P0-11/P0-12 established.
- **Chosen resolution:** **`declared_by` is dropped.** Provenance stores lineage, `declared_at`, `declaration_source = 'setup_cli'`, fixed-key evidence counters, and the retirement result. No name, email, user id, host, credential, or secret.

### Ordering corrections that follow

1. **Retire before creating.** The seed rule is deleted first, then the nine seed divisions, and only then is the customer's first division created. This is what lets a customer claim `GUDANG`, `MANAGEMENT`, or any other retired code — the unique index would otherwise reject it. The previous draft's order (delete → create → enable) is kept, but the reason is now explicit and is a test case.
2. **Last-capability guard is post-bootstrap only.** It fires only once `instance_bootstrap` or an authority assignment exists. Before then there is no authority to strand, which is what permits `IT` — flagged capability-bearing by the migration — to be retired inside the provisioning transaction.

## Workstream coverage

| Workstream | Planned delivery |
| --- | --- |
| A. Installation provenance | Immutable singleton row written only by the setup RPC; absent means UNKNOWN/LEGACY |
| B. Safe fresh retirement | Exact ten-row, positive-declaration, evidence-vetoed retirement inside bootstrap transaction |
| C. First customer division | Operator-supplied code/name created as `SETUP`, fully customer-owned |
| D. Transitional authority | Guarded `divisions.grants_system_authority` plus one shared application predicate |
| E. `update_user_access` | Normalized-first display and optional legacy synchronization |
| F. Category catalog | Empty-by-default `task_categories`, evidence-derived legacy backfill, no task FK |
| G. Category writes | One fail-closed repository-backed validator across all canonical task writes |
| H. Generic report | Parameterized `TASK_STATUS` with existing aggregation/index patterns |
| I. Legacy report alias | Registered only for LEGACY/UNKNOWN provenance |
| J. Collaboration checker | Structural/invariant checks only; origin assertion removed from default checker |
| K. Roles | Reserved STAFF/ADMIN/OWNER, stable codes, display-name rename only |
| L. Divisions | List/create/rename/deactivate/guarded delete; immutable code/capability |
| M. Categories | List/create/rename/deactivate; guarded hard delete only when unused |
| N. Collaboration rules | Existing CRUD completed with DELETE-as-deactivate and inactive endpoint denial |
| O. Setup CLI | Explicit lineage, preview, first division/existing division choice, no default |
| P. Verification | A–Z test matrix plus clean and legacy disposable-database rehearsals |

## Migration plan

Use **one** new forward migration:

`supabase/migrations/202609090002_implement_customer_taxonomy_transition.sql`

A single transaction minimizes registry exposure and guarantees that the legacy `IT` capability is installed before any predicate replacement becomes visible.

**Migration count: ONE — confirmed after reconciliation.**

| Criterion | One migration | Two staged migrations |
| --- | --- | --- |
| Old-app compatibility | Identical either way; both are additive plus signature-preserving replacements | Identical |
| Capability ordering | Guaranteed structurally: `IT` is flagged and predicates replaced in the same transaction, so no observer can see one without the other | Guaranteed only by convention and by both files applying |
| New tables | Same content | Same content, split arbitrarily |
| RPC replacement | Atomic with the capability grant it depends on | Risk of predicates live while the grant is not |
| Failure atomicity | All-or-nothing; a failure leaves the database exactly as before | **Stage A applied, stage B not** — a half-migrated registry state, the exact window flag-before-replace exists to prevent |
| Testing | One fixture, one apply, one row-count diff | Two apply points, plus a partial-apply state that must itself be tested |
| Deploy gate | One failure point before activation | Two |

One file wins on every criterion that differs. The single constraint it imposes: every index must be a plain `create index`, never `create index concurrently`, which cannot run inside a transaction. The tables involved are small enough that this is free.

### Ordered contents

1. Create `installation_provenance`, its append-only trigger, comments, RLS, and grants.
2. Create `task_categories`, updated-at trigger, comments, RLS, and grants.
3. Add `divisions.grants_system_authority boolean not null default false` and `divisions.provisioning_source text` with `CUSTOMER|PRESET|SETUP`/null constraint.
4. Add `roles.system_managed boolean not null default false`.
5. Insert `alert.acknowledge`; grant it to `OWNER`; mark `STAFF`, `ADMIN`, and `OWNER` system-managed.
6. Mark an existing `IT` division capability-bearing before changing any authorization body. This is the only permitted origin-code-specific compatibility update in the migration.
7. Install capability mutation/write-guard and last-capability/reserved-role triggers.
8. Replace, without changing existing signatures: `validate_system_admin_candidate`, `assign_system_admin`, `protect_final_system_admin_user`, `update_user_access`, `assert_it_system_admin`, and the critical-alert acknowledgment function. Keep the historical `assert_it_system_admin` name.
9. Replace the four-argument `bootstrap_first_admin` compatibility body; add the distinctly named `provision_first_installation`, the shared internal first-administrator helper, and the read-only `preview_first_admin_setup`. Revoke public/anon/authenticated access by exact signature and grant execute only to `service_role`. No function is overloaded (R-001).
10. Backfill `task_categories` from `select distinct task_category from public.tasks where task_category is not null`, deriving name from the code without any `AFFILIATE` literal.
11. Add required indexes and comments, then commit.

### Deploy compatibility

- Old app + new schema is supported: all new columns have defaults, new tables are unused by old code, and every pre-existing RPC signature remains callable.
- On legacy data, `IT` gains capability before predicate replacement, so existing SYSTEM_ADMIN authorization remains continuous.
- `update_user_access` is strictly more permissive for previously valid calls.
- OWNER receives `alert.acknowledge` before the database guard becomes permission-keyed.
- Old task writes accepted by the old app remain structurally valid. The new catalog validator exists only in the new app, so migration activation does not break old writes.
- The old setup CLI still succeeds against the new schema and produces a legacy-shaped install in `IT` with provenance absent (R-002). It is safe but is not an approved *clean* provisioning path; the matching-release CLI is mandatory for a new customer.
- The migration is forward-only. Application rollback may leave additive schema and replacement bodies in place; no down migration is planned.
- No operational deletion/deactivation executes during migration. The only destructive SQL text is encapsulated in the body of `provision_first_installation` and cannot execute without that RPC being invoked (R-003).

### Old app + new schema compatibility matrix

The deploy gate applies migrations *before* activating the new release, so the middle column is a real production state, not a hypothetical.

| Component | Old App + New Schema | New App + New Schema | Notes |
| --- | --- | --- | --- |
| `bootstrap_first_admin` (4 args) | **Safe.** Signature unchanged. Body resolves the single active capability-bearing division instead of literal `IT`. On legacy data `IT` carries the capability, so behavior is identical. On a freshly migrated database it succeeds into `IT` and yields a legacy-shaped install (R-002) | Not used for provisioning; retained as the compatibility entry point | Raises `TAXONOMY_UNAVAILABLE` on zero or >1 capability divisions — never guesses |
| `provision_first_installation` (7 args) | Not called by the old app; the function simply exists | The authoritative fresh/legacy provisioning path | New distinct name, so no overload resolution is involved anywhere |
| `update_user_access` (6 args) | **Safe.** Signature unchanged and the new body is strictly more permissive: every call the old app could previously make still succeeds | Customer divisions assignable; bootstrap admin manageable; normalized names propagate | The old app simply never exercises the newly permitted cases |
| `assign_system_admin` (3 args) | **Safe.** Signature unchanged; `IT` was flagged earlier in the same transaction, so an old caller passing an `IT` user still passes | Capability-keyed | Advisory lock unchanged |
| `validate_system_admin_candidate` (trigger) | **Safe.** Fires identically; the predicate outcome for an `IT` user is unchanged | Capability-keyed | Also covers direct `service_role` writes, as today |
| `protect_final_system_admin_user` (trigger) | **Safe.** Same outcome for a final admin sitting in `IT` | Capability-keyed | |
| `assert_it_system_admin` | **Safe.** Name retained per D-013; predicate outcome unchanged wherever `IT` exists | Capability-keyed | Comment records the semantic change |
| Alert acknowledgment guard | **Safe.** `OWNER` receives `alert.acknowledge` in the same migration, before the guard becomes permission-keyed | Permission-keyed | Behavior bit-identical on existing installs |
| Task ingestion (manual, CSV, automation, ERP) | **Safe.** The old app validates against its compiled `["AFFILIATE"]`; on a legacy install the backfilled catalog is a superset, so nothing the old app accepts is newly rejected. `tasks.task_category` gains no FK and no new constraint | Catalog-backed validator, fail-closed | The new validator lives only in the new app |
| Reporting | **Safe.** `AFFILIATE_TASK_STATUS` and its repository query are untouched by the migration | Generic `TASK_STATUS`; legacy alias registered only when lineage ≠ `FRESH` | No schema dependency either way |
| Collaboration checks | **Safe.** Table, constraints, and existing rows unchanged; inactive-endpoint denial is application-side only | Inactive endpoints deny; `DELETE` is an audited deactivation | Checker split is a script change, not a schema change |
| `divisions` / `roles` / new tables | **Safe.** New columns carry defaults; new tables are unreferenced by old code | Fully used | Repositories use explicit column lists |
| Old setup CLI | **Safe but not clean** (R-002) | Superseded by the matching-release CLI | Documented operational requirement, not a safety hole |

## Installation provenance

Exact table shape:

```sql
public.installation_provenance (
  singleton smallint primary key default 1 check (singleton = 1),
  lineage text not null check (lineage in ('FRESH', 'LEGACY')),
  declared_at timestamptz not null default now(),
  declaration_source text not null check (declaration_source = 'setup_cli'),
  evidence jsonb not null check (jsonb_typeof(evidence) = 'object'),
  origin_seed_retired_at timestamptz,
  origin_seed_retired_count integer,
  check (
    (lineage = 'FRESH' and origin_seed_retired_at is not null and origin_seed_retired_count = 10)
    or
    (lineage = 'LEGACY' and origin_seed_retired_at is null and origin_seed_retired_count is null)
  )
)
```

The count is nine divisions plus one collaboration rule. The setup function inserts the final row once near transaction completion; it never inserts then updates it. A trigger rejects every update and delete. The table starts empty. Absence is exposed to the application as `UNKNOWN`, and every consumer maps `UNKNOWN` to legacy-compatible behavior. There is no heuristic population, ordinary mutation API, email, name, user id, host identity, credential, or secret.

RLS is enabled with no policies. Revoke all table privileges from public/anon/authenticated and mutation privileges from service_role; grant service_role only `SELECT`. Only the table-owner `SECURITY DEFINER` `provision_first_installation` performs the insert. Its signature is revoked from public/anon/authenticated and executable by service_role only. A second declaration fails via singleton and bootstrap eligibility; it is not re-armable.

Evidence JSON uses fixed count keys only: `users`, `telegram_users`, `tasks`, `system_authority_assignments`, `admin_credentials`, `instance_bootstrap`, `non_migration_seed_audit_logs`, `extra_or_modified_seed_divisions`, `non_origin_collaboration_rules`, and all division-reference counters listed above. No row content or identity is stored.

## Setup flow and authoritative transaction

### CLI contract

Add mutually exclusive boolean flags `--fresh-install` and `--keep-existing-taxonomy`; exactly one is required in non-interactive mode. Add `--division-name` and `--division-code`. Keep `--name`, `--email`, and `--password-file`; never add `--password` or database credential flags.

- Interactive mode asks which lineage applies and requires a typed, explicit confirmation. There is no default on Enter.
- Fresh mode requires first-division name; code may be supplied or deterministically derived, displayed, and confirmed. The code uses the existing uppercase underscore contract and is immutable after commit.
- Keep-existing mode requires an existing active division code and does not accept/create a division name.
- Preview and eligibility happen before password collection.
- Non-interactive fresh mode logs the exact preview and requires both `--fresh-install` and the division fields.

### Read-only preview

`preview_first_admin_setup(p_lineage text)` performs no mutation. It returns only eligibility booleans, evidence counts, the exact eligible seed `(code,name)` pairs, and the exact origin-rule identity. The CLI prints those values. It is advisory: the authoritative RPC repeats every check under lock.

### One authoritative RPC

Add a new, distinctly named seven-argument function (no overload of `bootstrap_first_admin` — R-001):

```text
provision_first_installation(
  p_display_name,
  p_email,
  p_password_algorithm,
  p_password_hash,
  p_lineage,
  p_division_code,
  p_division_name
)
```

A distinct name removes the entire `PGRST203` overload-ambiguity risk class rather than relying on argument-name resolution, and gives each function its own grant. No plaintext password enters the database: the CLI hashes with scrypt in Node and passes algorithm and hash only, exactly as P0-12 established.

Under `pg_advisory_xact_lock(hashtextextended('gwens_system_admin_invariant', 0))`, the function:

1. Revalidates identity, credential material, lineage, and division inputs.
2. Requires `instance_bootstrap`, all authority history, all credentials, and provenance to be empty.
3. Recomputes the evidence veto.
4. For `FRESH`, verifies the exact retirement set and all reference gates.
5. For `FRESH`, deletes the one exact origin collaboration rule, then the nine exact seed divisions; no roles or permissions are removed or deactivated.
6. For `FRESH`, creates the operator-supplied customer division with `provisioning_source = 'SETUP'` and capability initially false.
7. For `LEGACY`, resolves exactly the named existing active division and creates no taxonomy.
8. Enables capability on the resolved division through the bootstrap-only internal path; no `IT` or `ADMINISTRATION` division is created.
9. Resolves reserved active role `ADMIN`; creates the active Telegram-less user and credential.
10. Grants only `SYSTEM_ADMIN`, never `OWNER`, retaining candidate and final-admin triggers.
11. Inserts the final immutable provenance row (`FRESH` with count 10, or `LEGACY` with null retirement fields).
12. Writes the singleton bootstrap marker, one first-admin audit, ten fresh-retirement audit rows when applicable, and one provenance audit. Audits contain codes/counts, not name/email/hash/salt/key.
13. Returns user id, assignment id, resolved division code, and timestamp; commit is all-or-nothing.

**Why this order (reconciled).** Retirement precedes division creation so a customer may claim a retired code — `GUDANG`, `MANAGEMENT`, or any other — which the unique index would otherwise reject. Capability enablement follows creation so the candidate trigger passes when `SYSTEM_ADMIN` is granted. Deleting `IT`, which the migration flagged capability-bearing, is permitted because the last-capability guard is scoped to installations that already have `instance_bootstrap` or an authority assignment, and at this point neither exists. Provenance is inserted once, complete, after retirement, so no partial row is ever visible.

**P0-12 invariants preserved unchanged:** the `gwens_system_admin_invariant` advisory lock; eligibility requiring no bootstrap marker, no authority history including revoked rows, and no administrator credential; scrypt hashing in Node with no plaintext crossing the database boundary; exactly one active user, one credential, one `SYSTEM_ADMIN`, one singleton marker, one sanitized audit record; never `OWNER`; no automatic re-arming; not a recovery path. P0-14 widens what the transaction additionally does, never what it permits.

The CLI can preview and collect input outside the transaction, but every authoritative eligibility, evidence, matching, deletion, capability, identity, credential, authority, provenance, marker, and audit action is inside this single RPC transaction.

The existing four-argument function remains for old callers. It preserves the lock and eligibility guards, resolves exactly one active capability-bearing division and `ADMIN`, and otherwise raises `TAXONOMY_UNAVAILABLE`. It never creates or retires taxonomy and never writes provenance.

## Exact fresh seed retirement

Eligible divisions are only these exact historical `(code,name)` pairs, with `active = true`, `provisioning_source is null`, and no modification evidence:

| Code | Name |
| --- | --- |
| `PURCHASING` | `Purchasing` |
| `SALES_GROSIR` | `Sales Grosir` |
| `DIGITAL_MARKETING` | `Digital Marketing` |
| `CONTENT_CREATOR` | `Content Creator` |
| `ONPAGE_B2C` | `On Page / B2C` |
| `SHOPEE_LIVE` | `Shopee Live` |
| `GUDANG` | `Gudang` |
| `MANAGEMENT` | `Management` |
| `IT` | `IT` |

The sole eligible rule is the active `ONPAGE_B2C -> CONTENT_CREATOR`, `task_scope = 'ALL'`, `allowed = true`, `requires_approval = false` row created by `migration_seed`. More than one matching row, any changed field, any extra rule, or missing expected row aborts fresh retirement. A customer row reusing a code with a different name is never touched; it causes a veto.

Positive `FRESH` declaration, never-provisioned state, zero evidence counts, exact identity, and zero relational references are all mandatory. Check every division FK listed in the baseline, historical authority via users, and substantive audit evidence. Preserve the known exact `migration_seed` rule audit entry; any non-seed audit or any other audit object/JSON reference to a candidate division/rule vetoes retirement.

The rule is deleted before divisions. Deletion count must be exactly one rule and nine divisions or the transaction raises and rolls back. Retirement never appears as top-level migration DML. Roles, permissions, role grants, Telegram schema, users, tasks, and other operational rows are never retired.

## Transitional SYSTEM_ADMIN capability

Add `divisions.grants_system_authority boolean not null default false`. Extend the division read model so joined actors expose `divisionGrantsSystemAuthority`.

### Database controls

- Ordinary inserts may only create the flag as false. The insert trigger rejects explicit true unless `current_user` is the owner of `public.divisions` (R-005).
- Ordinary update/PATCH cannot name the field. The update trigger rejects any change to the flag under the same owner check, which `service_role` cannot satisfy and cannot forge with `set_config`.
- `set_division_system_authority(p_division_id,p_enabled,p_actor_user_id,p_source)` is `SECURITY DEFINER`, pinned `search_path`, service-role-only, and requires an active SYSTEM_ADMIN actor already in an active capability-bearing division. `provision_first_installation` is the second owner-defined entry point and is reachable only before any bootstrap exists; both call one internal mutation routine, so there is a single implementation of the capability write.
- The setter locks the authority invariant, validates the target, prevents removal of the last active capability while authority/bootstrap state exists, updates atomically, and writes a sanitized audit.
- Deactivation/deletion triggers reject removal of the final active capability-bearing division **once `instance_bootstrap` or an authority assignment exists**. Before then the guard is inactive, which is what permits `IT` to be retired inside the provisioning transaction. More than one division may carry the capability; the invariant is "at least one", never "exactly one". A handover enables the replacement first, moves or assigns authority as needed, then disables the old capability.
- The migration flags `IT` before replacing predicates. A fresh setup later removes that exact unreferenced seed and enables the customer division in the same locked transaction.

### Predicate replacement order

1. Add column/default.
2. Flag legacy `IT` if present.
3. Install write guard and setter.
4. Replace `validate_system_admin_candidate`.
5. Replace `assign_system_admin`.
6. Replace `protect_final_system_admin_user`.
7. Replace the capability clause in `update_user_access`.
8. Replace body of historical `assert_it_system_admin` while retaining its identifier.
9. Replace bootstrap functions.
10. Activate the new application shared predicate in all seven TypeScript sites.

The shared helper in `src/auth/system-admin-capability.ts` checks active normalized user, assigned division/role, `divisionGrantsSystemAuthority === true`, and—where the caller has not already resolved from an active assignment—an active SYSTEM_ADMIN assignment. Error codes and route response shapes stay unchanged; messages may say “active SYSTEM_ADMIN in an authority-capable division” instead of “IT”. A division merely named `IT` receives no capability through customer create.

## Legacy display compatibility

Replace `update_user_access` without changing its six-argument signature.

- The normalized `users.division_id`, `users.role_id`, and joined catalog rows are the source of truth.
- Remove the `legacy_telegram_user_id is null` rejection.
- Remove dictionary-membership validation for target division and role.
- Preserve existence, active-assignment, active-user completeness, auditing, advisory lock, and final-admin checks.
- Compute legacy display values as:

```sql
division = coalesce(division_row.name, public.legacy_division_value(target_division_code), 'UNASSIGNED')
role     = coalesce(role_row.name, public.legacy_role_value(target_role_code), 'UNASSIGNED')
```

- Execute the `telegram_users` update only when `legacy_telegram_user_id` is non-null. If non-null but the legacy row is missing, retain the current deterministic `Legacy user not found` failure.
- Customer-created divisions become assignable. Reserved roles remain assignable. A renamed normalized division/role propagates its current name to linked Telegram display columns on the next access update.
- Leave both historical dictionary definitions untouched and preserve `UNASSIGNED` compatibility.

## Role policy

- Add `roles.system_managed`; mark only `STAFF`, `ADMIN`, and `OWNER` true.
- Codes remain immutable; these rows cannot be deactivated or deleted.
- Expose list and `PATCH /api/admin/roles/:id` with **name only**. Validate non-empty bounded display name. Audit atomically.
- Do not add custom role create/delete, grant editing, OWNER redesign, business actor settings, or approval changes.
- Remove PIC/Supervisor/Manager from current product-facing compile-time display enums, but continue treating legacy Telegram strings as opaque compatibility data.
- Add `alert.acknowledge`, grant it to OWNER, and make report/alert authorization permission-keyed. Keep `findTrustedOwnerActorUser` exactly-one OWNER resolution unchanged, but have `TrustedOwnerActorService` load active role permissions before returning the actor.

## Task-category catalog and write validation

Exact table:

```sql
public.task_categories (
  id bigint generated always as identity primary key,
  code text not null unique check (code ~ '^[A-Z][A-Z0-9_]{0,49}$'),
  name text not null check (length(trim(name)) between 1 and 120),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)
```

Use the existing updated-at function, RLS deny-by-default, no public policies, and no FK from `tasks.task_category`. Backfill distinct non-null task values with code unchanged and a deterministic display name derived generically (replace underscores with spaces); never spell `AFFILIATE` in backfill SQL.

Use one repository-backed `TaskCategoryService` as both management service and runtime validator. It caches the active-code set for a short bounded lifetime and invalidates immediately after successful create/rename/activate/deactivate/delete. Database errors fail closed; they do not fall back to the old enum.

Validation contract:

- Normalize non-null strings with trim + uppercase and enforce the existing code regex.
- Catalog empty: only `null`/omitted category is accepted; every non-null value returns `TASK_INVALID_CATEGORY`.
- Catalog non-empty: `null`/omitted remains valid; a non-null value must match an active catalog code.
- Inactive/unknown categories are rejected for create and category-changing update.
- Reads never validate existing task values.

Remove `TASK_CATEGORIES` and make `TaskCategory` a branded/plain validated string type. Synchronous HTTP/automation parsers perform shape/format normalization only. `TaskService` performs the one authoritative async catalog check for manual create, update, CSV, automation, and ERP intake. CSV row validation remains row-scoped; failures keep the existing import result contract. Telegram task creation currently emits null and remains valid. No hidden enum remains in adapters or tests.

### Category management

Expose `GET`, `POST`, `PATCH /:id` (name/active; code rejected as immutable), and guarded `DELETE` under `/api/admin/task-categories`. Choose hard delete only when zero tasks reference the code. Otherwise return `409 TASK_CATEGORY_IN_USE` and direct the operator to deactivate. Preserve historical tasks and immutable audit rows. No default category is created on a fresh install.

## Reporting transition

Add `GET /api/reports/task-status` with query parameters:

- `division` optional division code; absent means all divisions allowed by permissions.
- `task_category` optional catalog/historical code; absent means all categories.
- `window` required/parsed by existing TODAY/LAST_7_DAYS/LAST_30_DAYS rules.
- `statuses` optional comma-separated subset of existing task statuses.
- Existing `detail` and `page` drill-down semantics remain.

Rename repository query to `findTasksForReport(filters, startAt, endAt)`. Resolve division by code only when supplied, apply optional category/status filters, use the existing owner-division/category/created-at index pattern, and preserve aggregation and response timing semantics. Generic response definition is `TASK_STATUS`; it returns resolved filter values rather than origin literals.

Authorization is permission-keyed: home-division reporting requires `report.view_division`; cross-division/all-divisions requires `report.view_cross_division`. Existing exact OWNER actor resolution remains transitional and unchanged.

Read installation provenance once during application construction. Missing row maps to `UNKNOWN`. `reportsRoutes` registers the legacy `/content-creator/affiliate-task-status` route only when lineage is not `FRESH`. The handler forwards `{division: 'CONTENT_CREATOR', category: 'AFFILIATE'}` into the generic implementation and preserves the exact existing response/drill-down shape. Fresh customers do not receive the alias even if they later create those exact strings. Historical tasks remain readable when a category is inactive or absent from catalog.

## Division and collaboration management

### Divisions

Expose:

- `GET /api/admin/divisions` (active filter optional; capability visible read-only).
- `POST /api/admin/divisions` (code/name; `provisioning_source = 'CUSTOMER'`; capability forced false).
- `PATCH /api/admin/divisions/:id` (name and/or active only; code/capability/source rejected).
- `DELETE /api/admin/divisions/:id` (hard delete only after the complete reference-count RPC returns zero and the row is not an authority dependency).

Return deterministic codes: `DIVISION_NOT_FOUND`, `DIVISION_DUPLICATE_CODE`, `DIVISION_CODE_IMMUTABLE`, `DIVISION_INACTIVE`, `DIVISION_IN_USE`, and `DIVISION_AUTHORITY_REQUIRED`. Mutations run in audited database RPCs so reference check + write + audit are atomic. Per R-004 the delete guard counts only the eight relational division foreign keys; immutable audit history never blocks an ordinary division delete, so hard delete stays available for a genuinely unreferenced division and deactivation is the path for a referenced one.

### Collaboration rules

Keep the directional `ALL` scope and default deny. Extend runtime lookup to join both divisions and return no rule if either is inactive. Keep list/create/patch, add `DELETE /:id` as an idempotent audited **deactivation** rather than physical history loss, and retain validation: endpoints exist and active, source differs from target, unique active triple, denied cannot require approval. Use the shared system-admin capability predicate.

Update `check-collaboration-schema.ts` to assert table shape, directional constraints, partial uniqueness, RLS, default deny, and inactive-endpoint denial. Remove live origin-row count and exact origin-pair assertions. If an opt-in legacy checker is added, keep it outside the default fresh-install/release checks.

## Preset artifacts

Add `presets/preset.schema.json` and `presets/warehouse-b2b-b2c/1.0.0.json` matching the ADR. Add schema-validation coverage using existing tooling/Node APIs; do not add a runtime dependency. Do not add `npm run configure`, preset application code, migration seed data, or automatic preset activation in P0-14.

## Expected states

### Completed fresh setup

- Divisions: exactly the operator-created first division plus later customer-created divisions.
- Roles: active reserved `STAFF`, `ADMIN`, `OWNER` only.
- Task categories: empty until the customer creates one.
- Collaboration rules: empty until configured.
- Origin-company divisions and origin rule: absent.
- No `IT`; no `ADMINISTRATION`; no product-owned division.
- No automatically created `AFFILIATE` category.
- Generic `TASK_STATUS` available; legacy `AFFILIATE_TASK_STATUS` route absent.
- First admin belongs to the real customer division, role `ADMIN`, authority `SYSTEM_ADMIN`, no OWNER, no Telegram requirement.

### Legacy or UNKNOWN upgrade

- Every current division, user, task, Telegram mapping, integration/routing/alert reference, collaboration rule, role, permission, and audit row remains.
- Existing `IT` is capability-bearing before predicates switch; existing SYSTEM_ADMIN remains continuously valid.
- Historical `AFFILIATE` values are backfilled into the category catalog from data and remain readable/reportable even if later inactive.
- Existing collaboration rules remain active and directional.
- Provenance absent means `UNKNOWN`, and `UNKNOWN` behaves as LEGACY.
- Legacy report alias remains registered with its existing contract.
- There is no automatic destructive cleanup. Explicit fresh setup is refused by bootstrap/evidence gates on used or dormant legacy state.

## Exact test plan (A–Z)

| Ref | Planned assertion | Primary test file |
| --- | --- | --- |
| A | Fresh provenance is created only after explicit `--fresh-install`; no CLI default | `tests/taxonomy/p0-14-provenance.test.ts` |
| B | Missing provenance resolves to UNKNOWN and legacy-compatible behavior | `tests/taxonomy/p0-14-provenance.test.ts` |
| C | Dormant origin fixture cannot be inferred fresh; wrong declaration aborts unchanged | `tests/taxonomy/p0-14-database.test.ts` |
| D | Each evidence counter independently vetoes retirement | `tests/taxonomy/p0-14-database.test.ts` |
| E | Origin seed retirement occurs only inside explicit fresh setup and exactly 10 rows | `tests/taxonomy/p0-14-database.test.ts` |
| F | Exact pair matching protects modified/colliding customer rows | `tests/taxonomy/p0-14-database.test.ts` |
| G | No `ADMINISTRATION` or other fake/system-owned division is created | `tests/bootstrap/first-admin-bootstrap-database.test.ts` |
| H | First admin succeeds without `IT`, in supplied division, ADMIN + SYSTEM_ADMIN only | `tests/bootstrap/first-admin-bootstrap-database.test.ts` |
| I | Existing IT SYSTEM_ADMIN stays valid before/after migration predicates | `tests/taxonomy/p0-14-database.test.ts` |
| J | Customer-created division with code IT has capability false and grants nothing | `tests/taxonomy/taxonomy-management.test.ts` |
| K | Arbitrary customer division can be assigned through `update_user_access` | `tests/user-management/user-management.test.ts` |
| L | Renamed normalized division/role names propagate to linked legacy display | `tests/user-management/user-management.test.ts` |
| M | Arbitrary active category works on manual, update, CSV, automation, ERP canonical path | `tests/tasks/task-category-validation.test.ts` |
| N | Inactive/unknown category is rejected for every write; null rules cover empty/nonempty catalog | `tests/tasks/task-category-validation.test.ts` |
| O | Historical AFFILIATE task remains readable/reportable when inactive/uncatalogued | `tests/reporting/reporting-owner-console.test.ts` |
| P | FRESH customer creating CONTENT_CREATOR/AFFILIATE does not gain legacy alias | `tests/reporting/reporting-owner-console.test.ts` |
| Q | LEGACY and UNKNOWN retain alias and exact legacy response shape | `tests/reporting/reporting-owner-console.test.ts` |
| R | Migration executes no operational delete/deactivate; RPC-body exception is narrowly parsed | `tests/migration/historical-migration-integrity.test.ts` |
| S | Collaboration checker has structural assertions only; inactive endpoints deny | `tests/collaboration/cross-division.test.ts` |
| T | Full clean migration and fresh setup on disposable PostgreSQL | `tests/taxonomy/p0-14-database.test.ts` |
| U | Origin/legacy fixture migration on disposable PostgreSQL has byte/count-equivalent business rows | `tests/taxonomy/p0-14-database.test.ts` |
| V | Previous app runtime calls/signatures work against new schema; old setup caveat asserted | `tests/taxonomy/p0-14-compatibility.test.ts` |
| W | Full `npm test` regression, including expanded admin route matrix | existing suite + CI command |
| X | `npm run check:secrets`; CLI/RPC/audits contain no plaintext or credentials | checker + bootstrap tests |
| Y | `npm run typecheck` and `npm run build`; packaged setup remains runnable without dev dependencies | existing validation + bootstrap tests |
| Z | All 14 historical migration hashes match the pre-P0-14 manifest | `tests/migration/historical-migration-integrity.test.ts` |

Additional focused cases in those files: concurrent bootstrap; rollback after each fresh setup phase; provenance update/delete rejection; service-role/public RPC ACLs; RLS; forged capability body rejection; direct capability update rejection; last-capability deactivation/delete rejection; SQL/TypeScript predicate equivalence; capability handover ordering; non-Telegram admin management; reserved-role code/active/delete guards; category delete conflict; division reference counts for all eight FKs; generic status filters and index-shaped query; permission-keyed reporting/alerts; shared predicate at all seven sites; setup preview redaction; CLI flag exclusivity; cache invalidation; and preset schema/sample validation.

Database tests must use disposable PostgreSQL/Supabase only. They must never silently skip in the acceptance job. No live project is contacted.

## File change plan

### Footprint review

The first draft estimated **81 files**. Every row was re-examined against the repository; seven were found to be unjustified or conditional, and none of the acceptance criteria depend on them.

| Class | Count | Meaning |
| --- | ---: | --- |
| **REQUIRED P0-14 — production** | 42 | 1 migration + 41 `src/` files. Each is either an IT-literal authorization site, a compiled-taxonomy site, a new taxonomy surface, or the wiring that connects them |
| **REQUIRED P0-14 — checkers/data** | 6 | 4 existing checkers whose assertions the change invalidates, plus 2 preset data files required by ADR acceptance criterion 17 |
| **TEST ONLY** | 21 | Regression and new coverage for the A–Z matrix |
| **DOC ONLY** | 5 | `DECISIONS.md`, `ROADMAP.md`, `AI_HANDOFF.md`, `docs/deployment/vps-production.md`, `docs/architecture/authorization-model.md` — all written only after gates pass |
| **Firm total** | **74** | |
| **DEFER / CONDITIONAL** | 7 | Touch only if implementation evidence demands it; each must be justified in the implementation report |

**Removed from the firm plan, with reasons:**

| File | Class | Why it is not required |
| --- | --- | --- |
| `scripts/check-taxonomy-transition.ts` | DEFER | Its two jobs are static: "no destructive top-level DML" and "no IT predicate / no compiled category list". Both belong in `tests/migration/historical-migration-integrity.test.ts`, which already runs in CI and in the acceptance job. A separate checker duplicates the assertion and adds a release-gate surface. Add it only if the live-database release gate is shown to need a runtime variant |
| `package.json` | DEFER | Its only stated purpose was registering that checker |
| `tests/migration/migration-runner.test.ts` | DEFER | Verified: contains no division, role, or category literal, and no hardcoded migration count. Adding one migration does not change runner ordering or duplicate-protection behavior |
| `tests/go-live/stage2-foundation.test.ts` | CONDITIONAL | Verified: uses `IT` only as an inert fixture division for business-user-code tests. It breaks only if the shared `Division` type gains a **required** field — which the reconciled design avoids by carrying `grantsSystemAuthority` on the actor read model and the admin catalog DTO, not on the shared governance type |
| `tests/deployment/deploy-release.test.ts` | CONDITIONAL | No deploy script changes in P0-14. The "matching-release setup" point is documentation (`vps-production.md`), not asserted behavior |
| `src/user-management/types.ts` | CONDITIONAL | `updateAccess` input/output shapes do not change. Capability is exposed through the new admin division catalog DTO, not the user-management catalog |
| `tests/fixtures/legacy-schema-contract.json` | CONDITIONAL | Already marked "only if the generated contract requires additive objects" |

**Deliberate scope-limiting decision that produces the reduction:** the capability flag is carried on the **actor read model** (`users` / `task-users` repositories) and the **admin division catalog DTO**, never as a required field on the shared `Division` governance type. Every fixture in the existing suite that constructs a `Division` therefore stays valid, and the change is confined to the paths that actually make authorization decisions. An absent or undefined value is treated as `false` — fail-closed.

**Why the 42 production files genuinely change**, by group:

- **7 files** — the IT-literal authorization sites named in the verified baseline. Each must move to the shared predicate or SQL and TypeScript diverge.
- **6 files** — the compiled category sites (`tasks/types`, `task-validation`, `ingestion/types`, `automation-validation`, `task.service`, `task-ingestion.service`). Leaving one behind produces path-dependent validation, which is risk 4.
- **5 files** — OWNER-literal authorization consumers moving to permission checks (`reporting.service`, `critical-alert.service`, `task-actor.service`, `reports.routes`, `critical-alerts.routes`; two overlap with the IT group).
- **8 files** — new surfaces that do not exist today: capability predicate, provenance repository, category repository/service, taxonomy service, taxonomy routes, plus the two preset data files.
- **9 files** — repositories and services whose queries change shape (divisions, roles, users, task-users, reporting, collaboration, system-authority, user-management, first-admin-bootstrap).
- **5 files** — type modules that carry the new models.
- **3 files** — `app.ts` wiring, `cli/setup.ts`, and `types/index.ts` enum removal.
- **1 file** — the migration.

Expected P0-14 implementation footprint: **74 files firm** (1 migration, 41 `src/` files, 4 checkers, 2 preset data files, 21 test files, 5 project documents), plus **7 conditional** files that are touched only with a recorded justification. This excludes this planning document itself. The count is an expectation, not a target: if evidence adds a file, stop and update this plan; if a listed file proves unnecessary, omit it and say why.

| File | Action | Reason | Risk |
| --- | --- | --- | --- |
| `supabase/migrations/202609090002_implement_customer_taxonomy_transition.sql` | Add | Entire ordered additive schema, adapters, provisioning function, and guarded runtime retirement | Critical |
| `src/app.ts` | Modify | Wire repositories/services/routes, provenance-gated alias, permissions, remove literal id fallback | High |
| `src/auth/system-admin-capability.ts` | Add | Single TypeScript authority-capability predicate | High |
| `src/governance/types.ts` | Modify | Capability/source/system-managed/category/provenance models | Medium |
| `src/user-management/types.ts` | **CONDITIONAL** | Only if `updateAccess` shapes actually change; capability is exposed through the admin division catalog DTO instead | Low |
| `src/types/index.ts` | Modify | Remove product-facing origin division and unused role display enums | Medium |
| `src/tasks/types.ts` | Modify | Remove compiled category enum; add runtime string/filter types | High |
| `src/tasks/task-validation.ts` | Modify | Shape/format parsing only; no enum | Medium |
| `src/ingestion/types.ts` | Modify | Runtime category type | Low |
| `src/ingestion/automation-validation.ts` | Modify | Remove category enum gate | High |
| `src/collaboration/types.ts` | Modify | Deactivation/delete and enriched endpoint models | Low |
| `src/reporting/types.ts` | Modify | Generic TASK_STATUS filters/results plus legacy type | Medium |
| `src/repositories/divisions.repository.ts` | Modify | Capability-aware reads and management RPCs | High |
| `src/repositories/roles.repository.ts` | Modify | Rename-only RPC | Medium |
| `src/repositories/task-categories.repository.ts` | Add | Catalog CRUD, active-code reads, usage count | High |
| `src/repositories/installation-provenance.repository.ts` | Add | UNKNOWN-safe read only | High |
| `src/repositories/users.repository.ts` | Modify | Candidate count by capability | High |
| `src/repositories/task-users.repository.ts` | Modify | Join/expose division capability | High |
| `src/repositories/first-admin-bootstrap.repository.ts` | Modify | Preview, lineage/division input, `provision_first_installation` call, errors/result | Critical |
| `src/repositories/system-authority.repository.ts` | Modify | Privileged division capability setter | High |
| `src/repositories/reporting.repository.ts` | Modify | Generic parameterized query | High |
| `src/repositories/division-collaboration.repository.ts` | Modify | Inactive-endpoint denial and deactivation contract | High |
| `src/services/taxonomy-management.service.ts` | Add | Division and role lifecycle policy | High |
| `src/services/task-category.service.ts` | Add | CRUD, cache, and shared fail-closed validator | High |
| `src/services/first-admin-bootstrap.service.ts` | Modify | Explicit lineage/division flow and dynamic result | Critical |
| `src/services/user-management.service.ts` | Modify | Capability-aware catalog and relaxed normalized assignment | High |
| `src/services/task.service.ts` | Modify | Await shared category validator at every write | High |
| `src/services/task-ingestion.service.ts` | Modify | Remove CSV enum gate; retain canonical TaskService validation | High |
| `src/services/reporting.service.ts` | Modify | Generic aggregation, filters, permission checks, alias adapter | High |
| `src/services/task-actor.service.ts` | Modify | Load OWNER permissions; keep exact OWNER resolver | High |
| `src/services/critical-alert.service.ts` | Modify | Permission-keyed view/ack authorization | High |
| `src/services/integration-administration.service.ts` | Modify | Shared capability predicate | High |
| `src/services/collaboration-rule-management.service.ts` | Modify | Shared predicate, validation, audited deactivation | High |
| `src/services/system-authority.service.ts` | Modify | Capability status/set operation and neutral status wording | High |
| `src/routes/taxonomy.routes.ts` | Add | Admin division/category/role endpoints at exact paths | High |
| `src/routes/system-authority.routes.ts` | Modify | Capability endpoint and actor resolution | High |
| `src/routes/reports.routes.ts` | Modify | Generic route and conditional legacy alias | High |
| `src/routes/critical-alerts.routes.ts` | Modify | Shared capability predicate for evaluator | High |
| `src/routes/admin-notifications.routes.ts` | Modify | Shared capability predicate | Medium |
| `src/routes/admin-user-management.routes.ts` | Modify | Shared capability predicate | Medium |
| `src/routes/collaboration-rules.routes.ts` | Modify | DELETE-as-deactivate and validation contract | Medium |
| `src/telegram/it-console.ts` | Modify | Capability authorization; identifier/menu label retained as compatibility | High |
| `src/cli/setup.ts` | Modify | Explicit lineage, preview, division input, confirmation | Critical |
| `package.json` | **DEFER** | Only needed to register the deferred checker | Low |
| `scripts/check-taxonomy-transition.ts` | **DEFER** | Assertions belong in the migration-integrity test; add only if the live release gate needs a runtime variant | High |
| `scripts/check-migration-baseline.ts` | Modify | Register P0-14 checker | Medium |
| `scripts/check-collaboration-schema.ts` | Modify | Structural-only checks | Medium |
| `scripts/check-first-admin-bootstrap.ts` | Modify | Provisioning-function/capability/no-IT assertions | High |
| `scripts/check-user-management.ts` | Modify | Capability candidates and neutral status | Medium |
| `scripts/check-reporting-schema.ts` | Modify | Catalog/backfill/index/generic report/provenance checks | Medium |
| `presets/preset.schema.json` | Add | Formal preset data contract only | Low |
| `presets/warehouse-b2b-b2c/1.0.0.json` | Add | Validated sample, never auto-applied | Low |
| `tests/taxonomy/p0-14-provenance.test.ts` | Add | A/B/U provenance and CLI declaration tests | High |
| `tests/taxonomy/p0-14-database.test.ts` | Add | C–F/I/T/U plus transaction/ACL/trigger tests | Critical |
| `tests/taxonomy/p0-14-compatibility.test.ts` | Add | V old-app/new-schema function contracts | Critical |
| `tests/taxonomy/taxonomy-management.test.ts` | Add | Division/role/category lifecycle and capability abuse cases | High |
| `tests/tasks/task-category-validation.test.ts` | Add | M/N all intake paths and cache behavior | High |
| `tests/migration/historical-migration-integrity.test.ts` | Add | R/Z immutable hashes and migration SQL policy | High |
| `tests/bootstrap/first-admin-bootstrap.test.ts` | Modify | New CLI/service/repository contract and redaction | Critical |
| `tests/bootstrap/first-admin-bootstrap-database.test.ts` | Modify | G/H/concurrency/rollback/fresh transaction | Critical |
| `tests/user-management/user-management.test.ts` | Modify | K/L/non-Telegram compatibility | High |
| `tests/tasks/task-core.test.ts` | Modify | Async catalog-backed create/update | High |
| `tests/ingestion/task-ingestion.test.ts` | Modify | CSV/automation/custom category behavior | High |
| `tests/reporting/reporting-owner-console.test.ts` | Modify | O/P/Q generic report and permissions | High |
| `tests/collaboration/cross-division.test.ts` | Modify | S arbitrary/inactive rules and checker decoupling | High |
| `tests/telegram/it-console.test.ts` | Modify | Capability rather than IT authorization | Medium |
| `tests/alerts/critical-alert-engine.test.ts` | Modify | Permission-keyed view/ack and capability evaluator | High |
| `tests/security/admin-route-boundary.test.ts` | Modify | Add taxonomy admin scope to manifest | Medium |
| `tests/security/admin-authorization-regression.test.ts` | Modify | Four auth cases for new taxonomy group | Medium |
| `tests/app.test.ts` | Modify | No division-id fallback and lineage route registration | Medium |
| `tests/contracts/legacy-contract.test.ts` | Modify | Preserve legacy report/Telegram contracts | High |
| `tests/governance/governance-foundation.test.ts` | Modify | New permission/reserved-role metadata | Medium |
| `tests/migration/migration-runner.test.ts` | **DEFER** | Verified: no taxonomy literal, no hardcoded migration count; adding one migration changes nothing it asserts | Low |
| `tests/deployment/deploy-release.test.ts` | **CONDITIONAL** | No deploy-script change in P0-14; the matching-release point is documentation | Medium |
| `tests/go-live/stage2-foundation.test.ts` | **CONDITIONAL** | Verified: `IT` is an inert fixture only. Breaks solely if the shared `Division` type gains a required field, which the actor-scoped capability decision avoids | Medium |
| `tests/fixtures/legacy-schema-contract.json` | **CONDITIONAL** | Only if the generated contract requires additive objects; legacy fields preserved | High |
| `DECISIONS.md` | Modify after acceptance | Record final P0-14 decisions and reconciliations | Medium |
| `ROADMAP.md` | Modify after all gates pass | Mark P0-14 status only after verification | Low |
| `AI_HANDOFF.md` | Modify after all gates pass | Exact resulting state, commands, residual risks | Medium |
| `docs/deployment/vps-production.md` | Modify after rehearsal | Matching-release setup flags and fresh/legacy procedure | High |
| `docs/architecture/authorization-model.md` | Modify after acceptance | Capability transitional model and permission-keyed guards | Medium |

If implementation evidence adds a file not in this table, stop and update/review the plan before widening the diff. If a listed file proves unnecessary, omit it and record why in the implementation report; do not create churn to satisfy the count.

## Implementation sequence

1. Start clean; record branch, status, HEAD, and SHA-256/Git hashes of all 14 historical migrations.
2. Resolve and approve the six ADR reconciliation points above. Do not write production code first.
3. Add failing static contract tests for provenance, migration non-destructiveness, capability order, exact old signatures, backfill without literals, RLS/ACLs, and historical hashes.
4. Add the one migration in ordered Stages A–C. Inspect SQL manually before running it anywhere.
5. Run migration/static tests and `git diff --check`; confirm old files are unchanged.
6. Apply all migrations to disposable PostgreSQL only. Prove clean migrate, old runtime function calls, legacy fixture continuity, capability trigger behavior, and no top-level destructive DML.
7. Add shared TypeScript capability predicate and extend division/actor read models. Migrate the seven sites one at a time with focused tests.
8. Implement provenance reader, setup preview, repository/service types, and CLI explicit-choice parsing. Keep password timing/redaction guarantees.
9. Implement `provision_first_installation` and database tests for fresh, legacy, concurrency, every veto, and rollback injection. Rehearse full fresh state.
10. Replace `update_user_access` behavior and prove customer division assignment, Telegram compatibility, rename propagation, and non-Telegram admin management.
11. Add task-category repository/service/cache and CRUD; remove compile-time enum gates; migrate TaskService, parsers, CSV, automation, ERP canonical path, and tests.
12. Implement generic reporting and permission-keyed OWNER consumers; gate legacy alias only from provenance.
13. Implement division/role management and capability endpoint through audited RPCs; test all reference counts and last-capability protections.
14. Finish collaboration inactive-endpoint denial and DELETE-as-deactivate; decouple checker from origin data.
15. Add preset schema/sample and validation test only.
16. Wire the taxonomy route group and services in `app.ts`; update centralized admin-route manifests and four-case auth regression matrix.
17. Run focused suites after each workstream, then the complete validation set: `npm run typecheck`, `npm run build`, `npm test`, `npm run test:contract`, `npm run check:secrets`, all schema checkers, disposable clean/legacy database rehearsal, package/release tests, and `git diff --check`.
18. Verify literal inventories: no runtime authorization predicate uses division code IT; no compile-time task category allow-list remains; legacy dictionaries/report adapter contain only intentional compatibility literals.
19. Review the entire diff, migration hashes, file list, and old-app/new-schema evidence. Do not contact live Supabase.
20. Only after every acceptance criterion passes, update DECISIONS, ROADMAP, AI_HANDOFF, deployment and authorization documentation. Do not commit or deploy without separate instruction.

## Top implementation risks

1. **Bootstrap/retirement atomicity:** any application-side split could leave taxonomy deleted without an admin. Only the single RPC is authoritative.
2. **Authority continuity:** wrong ordering or predicate drift could invalidate the existing sole SYSTEM_ADMIN or let a name-only `IT` division grant privilege.
3. **Dormant legacy destruction:** operator declaration must never override evidence, exact identity, or reference vetoes.
4. **Hidden category gates:** leaving one enum in parsing/CSV/automation would produce path-dependent behavior; database failures must not become permissive cache fallbacks.
5. **Deploy-window and legacy contracts:** old runtime callers, legacy Telegram display, historical reports, immutable identifiers, and all existing data must survive additive schema activation.

## Stop conditions

Stop and return for architecture review if any of the following occurs:

- Any historical migration must be edited, reordered, renamed, deleted, or re-timestamped.
- A reconciled decision R-001 … R-006 turns out to be unimplementable as written.
- Fresh/legacy lineage would need to be inferred from row counts, names, codes, environment, or migration state.
- Any migration would execute delete, truncate, or operational deactivation when applied.
- The exact retirement set cannot be proven, any delete count differs, or any listed reference cannot be checked atomically.
- Old runtime app calls cannot operate against new schema with unchanged signatures and previously valid behavior.
- The first admin requires a fake `IT`, `ADMINISTRATION`, system-owned, or null division.
- Capability transition requires dropping candidate validation, weakening final-admin protection, or trusting division code/name.
- Direct capability writes cannot be reliably rejected in disposable-database tests.
- Setup cannot keep provenance, retirement, division, capability, identity, credential, authority, marker, and audits in one transaction.
- The four-argument `bootstrap_first_admin` cannot be retained alongside the distinctly named provisioning function without a resolution conflict.
- An existing regression expectation must change for reasons other than the explicitly approved taxonomy behavior.
- Task category validation cannot be made common to every write path without changing external error contracts.
- OWNER actor resolution, custom roles/grants, sessions/login, UI, presets application, production access, or other out-of-scope redesign becomes necessary.
- A required database test cannot run on disposable infrastructure or would require live Supabase/VPS access.
- Repository inventory materially differs from this plan, including a new division FK/write path or admin route group.

## Final P0-14 scope

| Feature | P0-14 | Deferred |
| --- | --- | --- |
| Installation provenance | Immutable singleton, written once by `provision_first_installation`, absent ⇒ UNKNOWN ⇒ LEGACY | Any post-bootstrap write path; any lineage other than FRESH/LEGACY |
| Seed retirement | Setup-only, seven gates, exactly 10 rows, one-shot, audited | Any migration-time or automatic cleanup; any retirement after bootstrap |
| First customer division | Operator-supplied name, code supplied or derived and confirmed, created in the provisioning transaction, fully customer-owned | Multi-division onboarding wizard; preset-driven initial taxonomy |
| SYSTEM_ADMIN bridge | `divisions.grants_system_authority` + owner-guarded setter + one shared predicate across 5 SQL and 7 TypeScript sites | Removing the flag; user-level eligibility (P1-01) |
| Division CRUD | List, create, rename, activate/deactivate, guarded hard delete | Bulk operations, merge, import/export, UI |
| Role rename | `GET` + `PATCH /:id` name only, on the three reserved roles | — |
| Custom role creation | — | P3-03 |
| Role → permission grant editing | — | P3-03 |
| Category CRUD | List, create, rename, activate/deactivate, guarded delete; one fail-closed validator on every write path | Per-category workflow, FK migration, category hierarchies |
| Collaboration CRUD | List, create, patch, `DELETE` as audited deactivation, inactive-endpoint denial | Physical rule deletion; `task_scope` values beyond `ALL` |
| Generic reporting | `TASK_STATUS` parameterized by division, category, window, statuses; permission-keyed | New report definitions; report builder |
| Legacy alias | `AFFILIATE_TASK_STATUS` registered only when lineage ≠ FRESH | Removal at v1.1 with a CHANGELOG deprecation |
| Preset schema | `presets/preset.schema.json` + validated Warehouse B2B+B2C sample, plus a schema-validation test | — |
| Preset apply tooling | — | After P0-14 (`npm run configure`) |
| OWNER redesign | — | P2-01. `findTrustedOwnerActorUser` exactly-one resolution is preserved verbatim |
| Business actor / `instance_settings` | — | P2-01 |
| Notification preference redesign | — | P2-01 / P2-03 |
| Full RBAC editor | — | P3-03 |
| Legacy dictionary removal | — | Post-v1 |
| Multi-tenancy, WhatsApp, ERP, sessions, UI | — | Out of scope entirely |

## Acceptance gate

**The architecture gate is closed.** All six inconsistencies are reconciled in **Reconciled architecture decisions** above and in ADR P0-13, whose status is now *Accepted for P0-14 Implementation*. The plan is sequenced and executable without further architecture design.

**P0-14 MAY PROCEED TO IMPLEMENTATION.**

Remaining gates are implementation-evidence gates, not design questions: the stop conditions above, the A–Z test matrix, disposable-database rehearsals for both clean and legacy fixtures, and the full validation set. Two open items are carried from the ADR and block *rehearsal sign-off* rather than coding: a read-only reference check on the origin instance before its upgrade, and the n8n contract-impact review for `owner_division` / `task_category`. Neither blocks writing P0-14 code, because no migration deletes anything on any installation.
