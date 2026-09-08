# P0-13 Architecture Adversarial Review

**Reviewer:** Antigravity (Adversarial Architecture Review)  
**Target Document:** [`docs/adr/P0-13-taxonomy-transition.md`](file:///c:/Users/Acer/Music/sotoayam/docs/adr/P0-13-taxonomy-transition.md)  
**Supporting Evidence:** [`docs/reviews/P0-13-taxonomy-inventory.md`](file:///c:/Users/Acer/Music/sotoayam/docs/reviews/P0-13-taxonomy-inventory.md), [`docs/adr/P0-11-first-admin-bootstrap.md`](file:///c:/Users/Acer/Music/sotoayam/docs/adr/P0-11-first-admin-bootstrap.md)  
**Date:** 2026-09-09  

---

## Verdict

**PERLU REVISI**

The proposed ADR provides solid analysis of current database constraints and correctly identifies the primary blockers (notably `update_user_access`). However, it suffers from two high-severity safety defects (unreliable heuristic lineage classification and an inverted COALESCE logic bug in legacy mapping), one unnecessary taxonomy replacement (`ADMINISTRATION` division replicating the `IT` flaw), and scope creep into business actor settings. These must be revised before P0-14 implementation.

---

## Executive Summary

The transition of business taxonomy from compiled source/seeds to customer configuration is a crucial milestone for Sotoayam v1.0. `docs/adr/P0-13-taxonomy-transition.md` accurately pinpoints that storage structures (`divisions`, `roles`, `division_collaboration_rules`, `tasks.task_category`) are already configuration-shaped.

However, the proposed architecture introduces several critical vulnerabilities and design flaws:

1. **Heuristic Lineage Hazard (F-001):** Classifying `FRESH` vs `LEGACY` by counting existing rows at migration time will misclassify dormant, staged, or backup installations as `FRESH`, triggering destructive deletion of origin seed rows.
2. **Inverted Display Mapping Precedence (F-002):** The proposed `update_user_access` replacement uses `coalesce(legacy_division_value(code), division_row.name)`. Because the hardcoded legacy dictionary is evaluated first, legitimate edits by customers to division display names will be completely ignored for legacy users.
3. **Replaced Hardcoding with `ADMINISTRATION` (F-003):** Replacing the hardcoded `IT` division with a mandatory, immutable, system-managed `ADMINISTRATION` division violates the core PRD mandate that commercial customers must not inherit an organizational structure they do not have.
4. **Accidental Legacy Report Coupling (F-004):** Gating `AFFILIATE_TASK_STATUS` reporting compatibility on the mere existence of division `CONTENT_CREATOR` and category `AFFILIATE` creates an accidental trap where a fresh customer defining those names gets legacy reporting semantics.
5. **Scope Creep (F-005):** The introduction of `instance_settings`, `business_actor_user_id`, and `approval.decide` permission redesign is an unnecessary expansion of P0-14 taxonomy scope.

---

## Strong Decisions

The following proposals in the ADR are sound and should be retained:

1. **Forward-Only Additive Migrations:** Preserving historical migration files byte-for-byte and maintaining Supabase CLI migration registry integrity.
2. **Write-Side Task Category Validation Without Foreign Keys:** Keeping `tasks.task_category` as a free-form string while validating new writes against `public.task_categories`. This avoids table rewrites, prevents FK deadlocks on high-throughput task insertion, and preserves historical uncatalogued task queries.
3. **Permission-Keyed Authorization:** Moving authorization checks from hardcoded role names (e.g., `roles.code = 'OWNER'`) to explicit permission grants (`alert.acknowledge`, `report.view_cross_division`).
4. **Removal of `update_user_access` Blockers:** Removing the mandatory `legacy_telegram_user_id` check and the strict legacy dictionary rejection. This unblocks managing the P0-11 bootstrap administrator and assigning users to customer-created divisions.
5. **JSON Data Format for ICP Presets:** Designing presets as versioned, declarative JSON files applied via API/CLI rather than embedding them in SQL DDL migrations.
6. **Immutable Division Codes:** Enforcing immutable `code` as the external contract identifier while keeping `name` freely editable.

---

## Findings

### F-001 — Heuristic Lineage Classification Can Destroy Dormant Existing Databases

- **Severity:** HIGH
- **ADR Location:** §14.1 (Lines 160–183) & §14.2 (Lines 184–195)
- **Problem:** The ADR classifies an installation as `FRESH` if `users = 0`, `tasks = 0`, `telegram_users = 0`, `instance_bootstrap = 0`, `system_authority_assignments = 0`, and non-seed `audit_logs = 0`.
- **Failure Scenario:** Consider a dormant, staging, pre-provisioned, or standby database deployed months ago where historical migrations ran and origin seed rows exist, but no users or tasks were created yet. When the P0-14 migration runs, the classifier evaluates all counts as 0 and classifies the installation as `FRESH`. The triple gate executes and **destructively deletes the origin division rows** (`PURCHASING`, `SALES_GROSIR`, `GUDANG`, etc.) and the collaboration rule. This breaks the fundamental commitment: *"LEGACY installations receive zero destructive deletes."*
- **Recommended Direction:** Rely on **Positive Install Provenance** or **Avoid Destructive SQL Deletions Entirely**. Database migrations must not attempt heuristic intent detection. If seed retirement is needed on clean installs, it must be an explicit command during fresh setup (e.g. `npm run setup`) or positive deployment configuration, not an automated heuristic in a forward SQL migration.

---

### F-002 — Inverted Precedence in Legacy Display Mapping Breaks Renaming

- **Severity:** HIGH
- **ADR Location:** §19 (Lines 413–418)
- **Problem:** To preserve backward compatibility for Telegram display columns, the ADR specifies:
  ```sql
  coalesce(public.legacy_division_value(code), division_row.name)
  coalesce(public.legacy_role_value(code), role_row.name)
  ```
- **Failure Scenario:** On an existing installation, if an administrator renames division `SHOPEE_LIVE` from `"Shopee Live"` to `"Marketplace Streaming"`, the database row `divisions.name` updates to `"Marketplace Streaming"`. However, when `update_user_access` runs, `public.legacy_division_value('SHOPEE_LIVE')` returns `"Shopee Live"`. Because `legacy_division_value` is evaluated first in `COALESCE`, it returns `"Shopee Live"`. The customer's custom display name is completely discarded and overridden by the static compiled SQL dictionary!
- **Recommended Direction:** Invert the precedence:
  ```sql
  coalesce(division_row.name, public.legacy_division_value(code))
  ```
  The database row `divisions.name` (which was initialized with the seed name anyway) must always take precedence over static legacy functions.

---

### F-003 — Mandatory `ADMINISTRATION` Division Replaces One Hardcode With Another

- **Severity:** MEDIUM
- **ADR Location:** §15 (Line 228), §18 (Lines 319–320), §20 (Lines 433–434)
- **Problem:** The ADR proposes creating a permanent, system-managed `ADMINISTRATION` division on fresh installs so that `bootstrap_first_admin` has a division with `grants_system_authority = true`.
- **Failure Scenario:** A small commercial business (e.g. 1 Owner, 2 Sales, 1 Warehouse, 1 Finance) installs Sotoayam. They are forced to carry an unwanted "Administration" division in their org chart that cannot be deleted or recoded. This directly violates PRD §2.7 and Roadmap P0-13 goals.
- **Recommended Direction:** Decouple `SYSTEM_ADMIN` eligibility from business division structure (see SYSTEM_ADMIN Model Assessment below), or allow initial bootstrap to bind to the customer's real organizational division without a mandatory permanent system division.

---

### F-004 — Name-Based Legacy Reporting Alias Activation Traps Fresh Customers

- **Severity:** MEDIUM
- **ADR Location:** §17 (Lines 356–358)
- **Problem:** The ADR states: *"The id `AFFILIATE_TASK_STATUS` is registered only when both `CONTENT_CREATOR` and `AFFILIATE` resolve on that installation..."*
- **Failure Scenario:** A fresh e-commerce customer creates a division `CONTENT_CREATOR` (for social media staff) and a task category `AFFILIATE` (for influencer marketing). Suddenly, the deprecated origin-company report alias `AFFILIATE_TASK_STATUS` activates in their reporting API!
- **Recommended Direction:** Feature availability and legacy aliases must depend on **installation lineage / explicit configuration mode**, never on string coincidence in customer-created taxonomy.

---

### F-005 — Scope Expansion: `business_actor_user_id` and Settings Table in P0-14

- **Severity:** MEDIUM
- **ADR Location:** §16 (Lines 281–290), §21 (Item 7, Line 450)
- **Problem:** The ADR introduces `public.instance_settings`, a new singleton table, new settings APIs, and a three-step fallback resolution for `findTrustedOwnerActorUser` involving `business_actor_user_id` and `approval.decide`.
- **Failure Scenario:** P0-14 is burdened with implementing a general settings infrastructure, new HTTP routes, and redesigning task approvals. This increases implementation surface area and risks delaying Phase 0 completion.
- **Recommended Direction:** **DEFER** `instance_settings` and `business_actor_user_id` to Phase 2 (Runtime Settings / P2-01). In P0-14, maintain the existing `OWNER` role as a product-provided default role, but gate actions on the new permissions (`alert.acknowledge`, `report.view_cross_division`).

---

### F-006 — Division Capability Flag Retains Semantic Coupling

- **Severity:** LOW
- **ADR Location:** §18 (Lines 293–304)
- **Problem:** `divisions.grants_system_authority` still ties system administration eligibility to organizational divisions.
- **Failure Scenario:** A company wanting to grant `SYSTEM_ADMIN` to a warehouse manager or finance lead must flag the entire "Warehouse" or "Finance" division as `grants_system_authority = true`. Consequently, any active user in Warehouse or Finance becomes a valid candidate for `assign_system_admin`.
- **Recommended Direction:** Acknowledge this limitation as an acceptable interim bridge for v1.0, or transition to user-level assignment validation.

---

## Install Lineage Assessment

The ADR's `installation_profile` proposes a binary lineage: `FRESH` vs `LEGACY`.

| Model | Evaluation | Security & Reliability Verdict |
| :--- | :--- | :--- |
| **Heuristic Classification (Proposed)** | Evaluates row counts across 6 tables at migration execution time. | **UNSAFE.** Cannot differentiate between a brand-new installation and an empty/unbootstrapped legacy/staging database. Can trigger unwanted deletions. |
| **Positive Install Provenance (Recommended)** | An installation is only marked `FRESH` if an explicit clean-install token or deployment marker was passed during fresh installation. Otherwise defaults to `LEGACY`. | **SAFE.** Fail-closed. An unbootstrapped existing database safely defaults to `LEGACY` (zero deletes). |

**Recommendation:** If lineage classification is retained, the migration must default to `LEGACY` unless positive provenance exists.

---

## Seed Retirement Assessment

The ADR proposes a triple gate:
1. `lineage = 'FRESH'`
2. `(code, name)` matches historical seed
3. `inbound references = 0`

While Gate 2 and Gate 3 are strong backstops, destructive `DELETE` statements in migrations are inherently high-risk.

**Alternative Recommended Approach:**
Instead of destructive deletion in a migration:
1. **Mark / Deactivate:** Set `active = false` and `system_managed = false` for origin seeds, OR
2. **Fresh Installer Cleanup:** Perform the deletion in `npm run setup` exclusively when executing a fresh install with a confirmed clean state, OR
3. If executed in migration, require **Positive Install Provenance** where `FRESH` is explicitly declared, never guessed.

---

## SYSTEM_ADMIN Model Assessment

Comparison of the four architectural options:

| Option | Description | Pros | Cons | Recommendation |
| :--- | :--- | :--- | :--- | :--- |
| **Option 1: Division Capability Flag** (`divisions.grants_system_authority`) | Proposed by ADR. | Enforceable in DB trigger; decouples from literal string `'IT'`. | Still couples org chart to sysadmin; turns whole division into sysadmin pool. | **Acceptable for P0-14** if simplified. |
| **Option 2: User/Role Permission** | Check permissions at grant time. | Standard RBAC mental model. | Cannot be enforced via simple DB trigger against direct `service_role` writes without complex joins. | Not recommended for trigger. |
| **Option 3: Dedicated Eligibility State** | Separate table of eligible users. | Highly explicit. | Over-engineered; adds unnecessary tables. | Rejected. |
| **Option 4: Active User Only** | Any active user is eligible for `SYSTEM_ADMIN`. | Simplest; zero taxonomy coupling; matches commercial reality. | Relies solely on caller authorization rather than DB-level structural segregation. | **Best long-term architecture.** |

**Conclusion:** Option 1 is acceptable for P0-14 as an incremental step from P0-11, provided it does not require a mandatory system division. Option 4 should be the long-term target.

---

## Mandatory Division Assessment

The proposal to introduce a mandatory `ADMINISTRATION` division fails commercial acceptance criteria:
- It replaces `IT` with `ADMINISTRATION`.
- It pollutes customer-visible division dropdowns.
- It forces small businesses to explain why an "Administration" division exists when they only have Sales and Warehouse.

**Alternative:**
When `npm run setup` bootstraps the first administrator on a fresh install:
- Allow the operator to supply the initial division name (e.g. `--division "Management"` or `--division "HQ"`), OR
- Create a default division that is **fully editable and not system-locked**, OR
- Permit `SYSTEM_ADMIN` eligibility on any active division.

---

## Role Model Assessment

- **STAFF / ADMIN / OWNER:** Retaining these three as seeded defaults is appropriate.
- **Permission decoupling:** The ADR's proposal to drive authorization through permissions (`alert.acknowledge`, `report.view_cross_division`) rather than role codes is an excellent security enhancement.
- **PIC / Supervisor / Manager:** Removing these unused legacy display values from the core TypeScript enums while tolerating them as raw strings in legacy `telegram_users.role` is safe and clean.

---

## OWNER / Business Actor Assessment

The ADR proposes introducing `instance_settings.business_actor_user_id` to resolve the `findTrustedOwnerActorUser` singleton constraint.

- **Necessity for P0-14:** **NO.**
- **Existing behavior:** Today, `findTrustedOwnerActorUser` expects exactly one active user with `roles.code = 'OWNER'`. A fresh commercial customer creates their business owner with role `OWNER`.
- **Verdict:** **DEFER** `instance_settings` to Phase 2 (P2-01). In P0-14, maintain `OWNER` as a default role and decouple reporting/alert permissions from the literal code `'OWNER'`.

---

## Task Category Assessment

- **Table:** `public.task_categories (id, code, name, active, system_managed, created_at, updated_at)`.
- **Validation:** Write-side only in application services/intake.
- **Referential Integrity:** Free-form text column `tasks.task_category` preserved without foreign keys.
- **Verdict:** **SOUND.** This provides clean catalog management without risking migration lock contention or breaking historical task querying.

---

## Reporting Compatibility Assessment

- Generic `TASK_STATUS` report parameterized by division and category is a clean design.
- However, aliasing `AFFILIATE_TASK_STATUS` based on the existence of `CONTENT_CREATOR` + `AFFILIATE` is fragile (see Finding F-004).
- **Verdict:** Gate legacy aliases strictly on `installation_profile.lineage === 'LEGACY'`, not on customer taxonomy strings.

---

## Legacy Mapping Assessment

- Current proposal:
  ```sql
  coalesce(public.legacy_division_value(code), division_row.name)
  ```
- As identified in Finding F-002, this is an **inverted precedence bug**.
- **Correction:** Must be:
  ```sql
  coalesce(division_row.name, public.legacy_division_value(code))
  ```
  Database row state must always override static legacy mapping functions.

---

## Division Lifecycle Assessment

- **Code immutability:** Sound. Division codes are external integration keys (n8n, CSV) and must remain immutable once created.
- **Name mutability:** Freely editable.
- **Deactivation vs Deletion:** Division deletion is strictly blocked if referenced by tasks, users, or collaboration rules. Deactivation (`active = false`) is supported.
- **Inactive rule evaluation:** Collaboration evaluator treats rules with inactive divisions as absent (fail-closed / default-deny).
- **Verdict:** **SOUND.**

---

## Fresh Install Simulation

**Customer:** Small online shop (Owner, 2 Sales, 1 Warehouse, 1 Finance). No IT team, no Administration department.

1. **Clean Install & Migration:**
   - Database migrated.
   - Origin seeds removed or deactivated.
   - No unwanted `ADMINISTRATION` division forced upon customer.
2. **First Admin Bootstrap (`npm run setup`):**
   - Operator creates admin with display name, email, and password.
   - Admin assigned to initial customer division (e.g. `OWNER` role, `MANAGEMENT` or customer-specified division).
3. **Onboarding / Configuration:**
   - Customer creates divisions: `SALES`, `GUDANG`, `FINANCE`.
   - Customer creates task categories (or leaves empty).
   - Zero origin-company terms (`Shopee Live`, `Purchasing`, `On Page/B2C`, `Content Creator`) appear in catalogs, dropdowns, or API responses.

---

## Existing Install Simulation

**Customer:** Origin installation (IT, Content Creator, Affiliate tasks, existing SYSTEM_ADMIN, Telegram users).

1. **Upgrade Migration Applied:**
   - Stored lineage resolves to `LEGACY`.
   - **Zero rows deleted.** All 9 origin divisions and 1 collaboration rule preserved.
   - Division `IT` receives `grants_system_authority = true`.
   - Existing SYSTEM_ADMIN remains continuously authorized with zero downtime.
2. **Runtime Operations:**
   - Historical affiliate tasks continue to be queryable and reportable.
   - `update_user_access` succeeds for both legacy Telegram users and non-Telegram administrators.
   - Legacy display mapping functions provide fallback compatibility.

---

## Migration / Deploy Compatibility

The migration must adhere to expand/contract deployment compatibility:

```
[Old Application Running] ──> [Run P0-14 Migrations] ──> [Deploy & Restart New Application]
```

- **Additive Schema:** Adding columns (`grants_system_authority`, `system_managed`) to `divisions` and `roles` is safe for the running old application.
- **Function Replacement:** When `assign_system_admin` and `validate_system_admin_candidate` are updated to check `grants_system_authority`:
  - On a `LEGACY` install, the migration flags `IT` with `grants_system_authority = true` **before** updating the function bodies.
  - Therefore, any call from the old application passing an `IT` user continues to pass.
- **Deploy Safety:** Old application + new schema is verified **SAFE**.

---

## Scope Reduction Recommendations

| Decision in ADR | Classification | Rationale |
| :--- | :---: | :--- |
| `installation_profile` singleton | **REVISE** | Must use positive provenance, not heuristic row-counting. |
| Triple-gated seed retirement | **REVISE** | Ensure non-destructive or positive-provenance-gated. |
| `divisions.grants_system_authority` | **KEEP NOW** | Eliminates `'IT'` literal across SQL and TS. |
| Mandatory `ADMINISTRATION` division | **REVISE** | Do not force a permanent system division on fresh customers. |
| Roles STAFF / ADMIN / OWNER reserved | **KEEP NOW** | Keeps default role stability. |
| Permission-based authorization | **KEEP NOW** | High security value; decouples auth from role names. |
| `instance_settings` & `business_actor_user_id` | **DEFER** | Scope creep. Not required for taxonomy transition. |
| `task_categories` catalog table | **KEEP NOW** | Solves category hardcoding cleanly. |
| `TASK_STATUS` generic report | **KEEP NOW** | Removes hardcoded affiliate report dependency. |
| `AFFILIATE_TASK_STATUS` legacy alias | **REVISE** | Gate on `LEGACY` lineage, not on taxonomy string matching. |
| Inverted `COALESCE` in legacy mapping | **REVISE** | Fix bug so `division_row.name` takes precedence. |
| ICP Presets JSON format specification | **KEEP NOW** | Design format only; defer implementation tooling. |

---

## Security Abuse Matrix

| Abuse Case | Result | Reason |
| :--- | :---: | :--- |
| 1. Create division named `IT` | **SAFE** | `IT` literal is removed from privilege checks; flag defaults to `false`. |
| 2. Create division with `grants_system_authority: true` | **SAFE** | API rejects parameter; DB trigger rejects modifications outside SECURITY DEFINER setter. |
| 3. Create role named `OWNER` | **SAFE** | `roles.code` unique constraint rejects duplicate code. |
| 4. Create customer role with admin-like grants | **SAFE** | Governance permissions (`system_authority.manage`, etc.) are not customer-grantable. |
| 5. Deactivate last authority-bearing division | **SAFE** | DB trigger rejects deactivating or unsetting the last capability division. |
| 6. Move final SYSTEM_ADMIN to non-authority division | **SAFE** | `protect_final_system_admin_user` trigger enforces admin must stay in capability division. |
| 7. Deactivate final SYSTEM_ADMIN user | **SAFE** | `protect_final_system_admin_user` trigger prevents deactivation of sole active admin. |
| 8. Reuse legacy display strings | **UNSAFE in ADR** | Inverted COALESCE bug causes legacy dictionary to override customer edits. *(SAFE once F-002 fixed).* |
| 9. Import preset into populated taxonomy | **SAFE** | Create-only, `ON CONFLICT DO NOTHING`, dry-run support, no overwriting. |
| 10. Create category `AFFILIATE` on fresh customer | **UNSAFE in ADR** | Name-based report gating accidentally triggers legacy alias. *(SAFE once F-004 fixed).* |

---

## Required ADR Changes Before P0-14

The following changes are **mandatory blockers** before proceeding to P0-14 implementation:

1. **Fix Lineage Safety (F-001):** Replace the heuristic row-counting classifier with Positive Install Provenance, or make seed retirement an explicit install-time setup step rather than an automated migration deletion.
2. **Fix Display Mapping Bug (F-002):** Invert the COALESCE logic in `update_user_access` so that `division_row.name` overrides `legacy_division_value(code)`.
3. **Eliminate Mandatory `ADMINISTRATION` Division (F-003):** Do not impose a permanent, undeletable system-managed division on fresh commercial installs.
4. **Fix Legacy Report Alias Gating (F-004):** Ensure legacy report aliases are gated on installation lineage, not on the presence of customer taxonomy strings.
5. **Trim Scope Creep (F-005):** Remove `instance_settings` and `business_actor_user_id` from P0-14 scope.

---

## Non-Blocking Improvements

1. **Preset Schema Tooling:** Formalize the JSON schema in `presets/preset.schema.json` as a standalone documentation artifact.
2. **Checker Harness Maintenance:** Ensure `check-first-admin-bootstrap.ts` is added to `check-migration-baseline.ts`.

---

## Gate Decision

**P0-13 ADR MUST BE REVISED**

The ADR cannot proceed directly to P0-14 implementation until the 5 blocker issues above are corrected in `docs/adr/P0-13-taxonomy-transition.md`.

---

## Final Recommendation

The recommended architectural direction is:
- **Minimal Core:** Additive migrations for `divisions.grants_system_authority` and `task_categories`.
- **Bug Fix:** Invert the COALESCE precedence in `update_user_access`.
- **Safe Lineage:** Use positive provenance for `FRESH` installs; never heuristically delete data on existing databases.
- **Zero Mandatory Org Structure:** Commercial customers start with an empty or clean initial division, not an immutable `ADMINISTRATION` department.
- **De-scoped Settings:** Keep `instance_settings` out of P0-14.

