# P0-15 Origin-State Inventory

Inventory/classification only. No production code, migration, packaging, or documentation was modified. Inspected 2026-09-09 against commit `7c5e28f` (`feat(taxonomy): add customer-configurable taxonomy`), clean working tree except this document.

Inputs honored: `AI_CONTEXT.md`, `DECISIONS.md`, `ROADMAP.md`, `AI_HANDOFF.md`, PRD §2/§5/§9, `docs/reviews/P0-13-taxonomy-inventory.md`, `docs/adr/P0-13-taxonomy-transition.md`, `docs/reviews/P0-14-adversarial-review.md`. P0-14 already generalized runtime taxonomy (provenance-gated seed retirement, capability-based SYSTEM_ADMIN, data-backed categories, generic reporting with a lineage-gated legacy alias). P0-15 is therefore primarily a **documentation/packaging** cleanup, plus a small set of runtime-legacy items that must stay.

## Executive Summary

The repository is in good structural shape for a commercial split: the shipped product UI (`public/`) is brand-clean and protected by a regression test, fresh-install deployment defaults are fully parameterized (`/opt/sotoayam`, `sotoayam` service, `sotoayam.service`), `.env.example` is clean, and every origin-document now carries an explicit historical banner. The remaining origin-state falls into four buckets:

1. **One real packaging exposure (highest priority).** `scripts/deploy/package-release.ps1:22` ships `supabase/config.toml` in every customer release archive, and that file contains the origin-linked Supabase project id `gwensoto`. A commercial customer receives an origin identifier they cannot use and should not see. This is the only finding where origin state physically reaches a customer package unintentionally.
2. **One stale customer-facing README.** `README.md` contradicts the current product on four points (idempotency "not implemented" — false since P0-06; `ADMIN_API_KEY` "optional" — false since P0-03; manual single-migration instruction — superseded by `npm run migrate`; and an origin-business example "Stok Squishy Strawberry kritis"). The README also documents legacy identifiers — that part is correct and should stay, reworded for operators.
3. **Internal-only origin documents.** Five `docs/go-live-*.md` workbooks, `docs/beta-readiness.md`, and parts of `docs/architecture/` record the origin installation's users, divisions, collaboration rules, counts, timezone, and rollout steps. All already carry historical banners (good), but several **architecture** documents state stale claims that now contradict P0-14 (e.g. "initial seed codes" presented as design). These are internal engineering repository files; the fix is exclusion from any customer-facing material set plus correction of the stale claims — not deletion of history.
4. **Runtime legacy compatibility that must remain.** The `gwens` deployment identifier family, the `gwens-admin-key` browser storage key, `GWENS_LEGACY_SCHEMA_V1`, `gwens_*` advisory locks, the legacy display-name dictionary, and the `AFFILIATE_TASK_STATUS` alias chain are all deliberate compatibility contracts (documented in README and ADRs). The presence of these identifiers is **not** a defect; P0-15 must not rename them.

**No secrets, credentials, tokens, Telegram IDs, or customer personal data were found anywhere in the sweep.** The origin go-live documents explicitly record counts with personal identifiers omitted; `check:secrets` passed at P0-14 review and the scan surface has not changed since.

Classification legend: **A** Historical immutable · **B** Runtime legacy compatibility · **C** Internal engineering documentation · **D** Customer-facing documentation with origin state · **E** Test fixture · **F** Stale/dead state · **G** Branding violation.

## Search Scope

Swept with case-insensitive and literal patterns across the whole tree (excluding `node_modules/`, `dist/`, `.git/` — `dist/` and `tmp/` are gitignored build/temp output):

1. `gwens` / `Gwens` / `GWENS` — 57 occurrences across 25 files.
2. Origin division names: `PURCHASING`, `SALES_GROSIR`, `DIGITAL_MARKETING`, `CONTENT_CREATOR`, `ONPAGE_B2C`, `SHOPEE_LIVE`, `GUDANG`, `MANAGEMENT`, `IT`, `AFFILIATE`.
3. Founder/personal names, "founder", "Hermes", "Shopee", "BigSeller", "Meta".
4. NDA/confidentiality commentary.
5. Supabase project refs/URLs, example credentials, hardcoded IDs.
6. Old deployment paths, service names, system accounts.
7. Stale instructions vs current behavior (README vs P0-03/P0-06/P0-07).
8. Inspected in full or in relevant part: `README.md`, `AGENTS.md`, `AI_CONTEXT.md`, `AI_HANDOFF.md`, `DECISIONS.md`, `ROADMAP.md`, `SOTOAYAM_PRD.md`, `.env.example`, `package.json`, `.gitignore`, `supabase/config.toml`, all 15 migrations, `public/index.html`, `public/app.js`, all of `docs/` (adr, architecture, deployment, integrations, migration, plans, reviews), `scripts/` (all checkers, `deploy/*` including `package-release.ps1`), `presets/`, `src/` (targeted), `tests/` (targeted).

## Branding Findings

The official brand `Sotoayam` is correctly used in the UI (`public/index.html:6,12`, asserted by `tests/app.test.ts:120-128` including a `/Gwens|GWENS/` negation), `package.json` (`name: "sotoayam"`), and all fresh-install deployment defaults. **No G-class violation was found where old branding is displayed to end users.** All `gwens` occurrences are technical compatibility contracts or internal/history references:

| Value | Location | Classification | Customer Visible? | Recommended Action |
| --- | --- | --- | --- | --- |
| `/opt/gwens-automation` | `docs/deployment/vps-production.md:49`; `tests/deployment/deployment-config.test.ts:89,96`; (supported override in `deployment-config.sh`) | B | Only in the legacy-compatibility section of the deploy guide | KEEP — correctly framed as "Existing legacy installation compatibility", explicitly not a fresh-install recommendation |
| `gwens-automation.service` | same three locations | B | Same | KEEP |
| `gwens` system account/group | same three locations | B | Same | KEEP |
| `gwensoto` Supabase project id | `supabase/config.toml:6` — **shipped in the customer release archive by `package-release.ps1:22`** | B value, D-class exposure | **Yes — every release archive** | REMOVE FROM ARCHIVE or parameterize (top cleanup target; see Customer Package Exposure) |
| `gwens-admin-key` browser storage key | `public/app.js:7` | B | Runtime-visible to browser users (devtools only), not docs | KEEP — changing it silently orphans every existing operator's stored admin key; rename only with a coordinated fallback-read migration (post-v1) |
| `GWENS_LEGACY_SCHEMA_V1` contract id | `tests/fixtures/legacy-schema-contract.json:2`; consumed by `scripts/check-schema.ts:35` | B | No | KEEP — named compatibility contract |
| `gwens_system_admin_invariant` (and `gwens_*` advisory locks) | migrations `202608290003`, `202609010002`, `202609010004`, `202609020001`, `202609090001`, `202609090002`; asserted by `scripts/check-first-admin-bootstrap.ts:30`, `scripts/check-user-management.ts:16` | A (migrations) + B (checkers) | Only inside migration SQL shipped in the archive | KEEP — D-013; renaming an advisory-lock key changes the lock identity and breaks serialization against a live DB |
| `LOCAL_GWENS_POLLING` / `VPS_GWENS_POLLING` | `AGENTS.md:42,50` only — **no code, script, or env example references these names** | F (stale doc text) | No | REWORD in AGENTS.md to the real variable (`TELEGRAM_POLLING_ENABLED`) or mark the sentence as historical protocol context |
| Historical commit subject `chore: establish gwens automation baseline` | `docs/migration/baseline-v1.md:6` | A (Git history) + C | No | KEEP — explicitly documented as immutable history |
| Backup artifact name `gwens-production-public-20260902T093513Z.dump` | `docs/database-recovery.md:95` | C | Potentially (recovery runbook is operator material) | Generalize — keep the fact but present it as a historical example filename, not a pattern customers should expect |

## Origin Taxonomy Findings

Post-P0-14 runtime state is provenance-gated and was reviewed in `P0-14-adversarial-review.md` as sound. What remains in source is intentional compatibility or checker support:

| Value | Location | Classification | Customer Visible? | Recommended Action |
| --- | --- | --- | --- | --- |
| `DIVISION_SEEDS` (8 origin divisions + IT) | `src/governance/catalog.ts:1-11` | F at runtime; C as checker support | No | Relocate/label — the only consumers are `scripts/check-governance-foundation.ts:4-7` and `tests/governance/governance-foundation.test.ts:12`. It is a mirror of historical migration seed text used to validate that text, living misleadingly under `src/`. Move next to its consumer or add a header comment naming it as a historical-migration fixture, not a runtime seed |
| `ROLE_SEEDS`, `ROLE_PERMISSION_SEEDS`, permission catalogs | `src/governance/catalog.ts:13-76` | C (checker/test support; mirrors migration contract) | No | KEEP — same treatment as above; these encode the STAFF/ADMIN/OWNER product defaults, which remain valid |
| Legacy display-name dictionary | `src/identity/legacy-mapping.ts` (+ two SQL copies in `202608290002`/`202608290003`) | B | No | KEEP — runtime fallback consumed by `user-management.service.ts:74,83` and the reconciler; P0-13 ADR fixes retirement at the post-v1 contract stage |
| `AFFILIATE_TASK_STATUS` alias chain (`CONTENT_CREATOR` + `AFFILIATE` literals) | `src/routes/reports.routes.ts:56`; `src/services/reporting.service.ts:104-105`; `src/repositories/reporting.repository.ts:15-16` | B | Registered for admin-key holders on LEGACY/UNKNOWN lineage only; never on FRESH | KEEP until v1.1 (P0-13 ADR Reporting Transition; removal is P2-05 CHANGELOG material) |
| Origin-domain notification types `STOCK_CRITICAL`, `PURCHASE_RECOMMENDATION`, `SALES_FOLLOWUP`, `MARKETING_ALERT`, `CONTENT_OPPORTUNITY`, `OWNER_DAILY_REPORT` | `src/types/index.ts:2-7`; consumed by `src/validation.ts:84`, `src/services/recipient-resolver.service.ts:12`; documented with an origin product example in `README.md:59-79` | B (live n8n contract) | Docs: yes (README event table) | KEEP code (working integration contract); REWORD README example to a neutral business event; configurability is P2-01/P2-03, not P0-15 |
| Origin divisions/rules/counts in docs | `docs/go-live-configuration.md`, `go-live-collaboration-matrix.md`, `go-live-task-category-matrix.md`, `go-live-integration-registry.md`, `go-live-notification-routing.md`, `beta-readiness.md` | C (all carry explicit historical banners) | Only if included in customer material — they must not be | KEEP INTERNAL — exclude from customer package; banners are already correct |
| Origin rule as design example | `docs/architecture/cross-division-rules-v1.md:32,71` | C + stale framing | No | REWORD — present ONPAGE_B2C→CONTENT_CREATOR as the historical first rule, not a design requirement (P0-14 made rules customer data with zero fresh defaults) |
| "Initial seed codes" presented as current design | `docs/architecture/target-domain-model.md:21` | C + F (contradicts P0-14) | No | UPDATE — state that the historical seed exists in immutable migrations and is retired under provenance on fresh installs |
| Origin acceptance criterion | `docs/architecture/implementation-roadmap.md:71` | C + stale framing | No | UPDATE — same treatment |
| `AFFILIATE_TASK_STATUS` as canonical report | `docs/architecture/reporting-owner-console.md:7` | C + stale framing | No | UPDATE — generic `TASK_STATUS` is now canonical; the alias is compatibility-only (correctly described in `authorization-model.md:111`) |

## Deployment / Path Findings

| Item | Location | Classification | Customer Visible? | Recommended Action |
| --- | --- | --- | --- | --- |
| Fresh defaults `/opt/sotoayam`, `sotoayam`, `sotoayam.service` | `deployment-config.sh`; documented `vps-production.md:9-27` | Product default (clean) | Yes | KEEP — no origin state |
| Legacy identifiers `gwens*` as supported overrides | `vps-production.md:44-55` (dedicated section); `tests/deployment/deployment-config.test.ts:99` asserts no founder-specific default | B, correctly isolated | Yes, but correctly labeled | KEEP — this section is the model for how legacy material should read |
| `check-legacy-staged-runtime.mjs` origin business-data checker | `scripts/deploy/check-legacy-staged-runtime.mjs` | B/C | No — excluded from fresh archives, opt-in, documented `vps-production.md:142` | KEEP INTERNAL |
| `fix-systemd-network.sh`, `configure-local-bind.sh`, `rollback.sh`, `install-env.sh`, `deploy-release.sh`, `bootstrap-vps.sh` | `scripts/deploy/` | Clean (no origin literals found in sweep) | Yes (release archive) | KEEP |
| Hermes boundary statements | `vps-production.md:3,78`; `AGENTS.md:35` | C (origin-adjacent operational context, deliberately kept to protect a separate production system) | The deploy guide lines are customer-visible | KEEP — they are safety constraints ("never reuse the Hermes token"), not origin organization state; reword optional |
| `.env.example` | root | Clean — setup-time-only password note, safe defaults, no legacy names | Yes | KEEP |

## Documentation Findings

| Document | Origin state present | Classification | Customer package? | Recommended Action |
| --- | --- | --- | --- | --- |
| `README.md` | (1) `"message": "Stok Squishy Strawberry kritis."` origin product example (line 73); (2) "deduplikasi/idempotency event belum diterapkan" — **false since P0-06** (line ~68); (3) "Jika tidak diisi, API admin bersifat public" — **false since P0-03** (ADMIN_API_KEY is required at startup, ≥32 chars); (4) manual single-migration instruction naming only `202608260001` — superseded by `npm run migrate`; (5) legacy-identifier paragraph (correct and valuable) | D + F | Yes (repo entry point) | **MUST CLEAN NOW** — fix the three factual staleness claims, replace the origin product example with a neutral one, reframe the migration step to `npm run migrate`, keep the legacy-identifier paragraph reworded for operators |
| `docs/go-live-configuration.md` | Full origin operational snapshot: user counts, IT/ADMIN–MANAGEMENT/OWNER–CONTENT_CREATOR/STAFF roster shape, 9 divisions, business timezone, Shopee/Meta/Hermes planning, backup posture | C (banner present) | No | KEEP INTERNAL; candidate to move under `docs/internal/` or similar grouping at P0-16 time |
| `docs/go-live-collaboration-matrix.md` | Origin rule record | C (banner) | No | KEEP INTERNAL |
| `docs/go-live-task-category-matrix.md` | AFFILIATE/CONTENT_CREATOR record | C (banner) | No | KEEP INTERNAL |
| `docs/go-live-integration-registry.md` | Origin planning snapshot, Shopee row | C (banner) | No | KEEP INTERNAL |
| `docs/go-live-notification-routing.md` | Origin routing snapshot | C (banner) | No | KEEP INTERNAL |
| `docs/beta-readiness.md` | Origin staged-beta runbook and rollout steps (banner present) | C | No | KEEP INTERNAL |
| `docs/migration/baseline-v1.md` | Baseline commit subject, historical migration audit trail | C | No | KEEP INTERNAL |
| `docs/database-recovery.md` | Generic runbook; one historical dump filename (line 95) | C (minor) | Borderline — recovery runbook is operator material | Generalize the filename presentation; otherwise KEEP |
| `docs/architecture/target-domain-model.md` | Stale seed-code claim (line 21) | C/F | No | UPDATE to post-P0-14 truth |
| `docs/architecture/cross-division-rules-v1.md` | Origin rule example | C | No | REWORD example framing |
| `docs/architecture/implementation-roadmap.md` | Origin rule acceptance criterion (line 71) | C/F | No | UPDATE |
| `docs/architecture/reporting-owner-console.md` | Alias presented as canonical report | C/F | No | UPDATE |
| `docs/architecture/authorization-model.md`, `critical-alert-engine.md`, `governance-foundation.md`, `normalized-identity.md`, `task-*-foundation.md`, `current-state-review.md`, `database-migration-plan.md` | Clean or correctly historical (e.g. `authorization-model.md:111`) | C | No | KEEP INTERNAL |
| `docs/adr/*` (4), `docs/reviews/*` (5), `docs/plans/P0-14-implementation-plan.md` | Extensive origin references as design/audit evidence | C | No | KEEP INTERNAL — these are the audit trail proving why identifiers must not be renamed; deleting them would destroy institutional knowledge |
| `docs/integrations/n8n-contract.md` | Clean product contract | C/product | Yes (integration material) | KEEP; include in customer package |
| `docs/integrations/erp-discovery.md`, `bigseller-discovery.md` | Generic discovery checklists (no origin data; BigSeller/Shopee named as future connector candidates) | C/product | Borderline | KEEP; frame as future-integration discovery, not origin state |
| `AGENTS.md`, `AI_CONTEXT.md`, `AI_HANDOFF.md`, `DECISIONS.md`, `ROADMAP.md`, `SOTOAYAM_PRD.md` | References to founder-state cleanup tasks themselves; AGENTS.md polling-variable staleness (above) | C | No | KEEP INTERNAL; fix the two stale variable names in AGENTS.md |
| `presets/warehouse-b2b-b2c/1.0.0.json`, `presets/preset.schema.json` | ICP preset data — uses generic codes (`GUDANG_STOK`, `SALES_B2B`, …), no origin codes | Product data | Yes (optional onboarding material) | KEEP |
| `tests/fixtures/legacy-schema-contract.json` | `GWENS_LEGACY_SCHEMA_V1`, `UNASSIGNED` sentinel, origin-domain preference columns | E | No | KEEP + label as legacy fixture |

## Source Code Findings

| Item | Location | Classification | Customer Visible? | Recommended Action |
| --- | --- | --- | --- | --- |
| `LEGACY_ADMIN_KEY_STORAGE_KEY = "gwens-admin-key"` | `public/app.js:7` | B | Browser storage only | KEEP (see Branding) |
| `DIVISION_SEEDS` origin list | `src/governance/catalog.ts:1-11` | F (runtime-dead; checker fixture) | No | Relocate/label (see Origin Taxonomy) |
| Legacy dictionary + origin display names | `src/identity/legacy-mapping.ts` | B | No | KEEP |
| Alias literals `CONTENT_CREATOR`/`AFFILIATE` | `src/services/reporting.service.ts:104-105`; `src/repositories/reporting.repository.ts:15-16`; `src/routes/reports.routes.ts:56` | B (lineage-gated) | No | KEEP until v1.1 |
| Origin-domain notification type enum | `src/types/index.ts:2-20` | B (live contract) | No | KEEP; P2 owns configurability |
| `UNASSIGNED` sentinel | `src/identity/legacy-mapping.ts:21,26`; `src/repositories/telegram-users.repository.ts:34,36` | B | No | KEEP — dies with legacy columns post-v1 |
| Brand-clean UI | `public/index.html`, `public/app.js` (all other content) | Product (clean) | Yes | KEEP; regression test `tests/app.test.ts:120-128` guards it |

No `gwens` literal exists anywhere in `src/` — the advisory-lock and deployment identifiers never crossed into application code. No origin division literal exists in any authorization predicate after P0-14 (verified by the P0-14 review, case H).

## Test Fixture Findings

| Fixture | Location | Classification | Recommended Action |
| --- | --- | --- | --- |
| Origin divisions/codes in fixtures (`IT`, `SALES_GROSIR`, `CONTENT_CREATOR`, `ONPAGE_B2C→CONTENT_CREATOR`, `SHOPEE_LIVE`, etc.) | `tests/user-management/user-management.test.ts:17`, `tests/collaboration/cross-division.test.ts`, `tests/telegram/it-console.test.ts`, `tests/identity/normalized-identity.test.ts`, `tests/go-live/stage2-foundation.test.ts:17`, `tests/reporting/reporting-owner-console.test.ts`, `tests/ingestion/task-ingestion.test.ts`, `tests/telegram/task-console.test.ts`, `tests/telegram/authorization-state.test.ts`, `tests/tasks/task-core.test.ts`, `tests/tasks/task-category-validation.test.ts`, `tests/alerts/critical-alert-engine.test.ts` | E | KEEP — they intentionally exercise legacy compatibility and historical-migration contracts; add a one-line comment in each fixture header naming it a legacy-compatibility fixture where not already obvious |
| `gwens` deployment identifiers | `tests/deployment/deployment-config.test.ts:89-96` | E | KEEP — proves legacy overrides resolve; line 99 asserts no founder default exists |
| `GWENS_LEGACY_SCHEMA_V1` fixture | `tests/fixtures/legacy-schema-contract.json` | E (consumed by `scripts/check-schema.ts`) | KEEP + label |
| Origin seed assertions over migration text | `scripts/check-governance-foundation.ts:51-53` (via `DIVISION_SEEDS`), `scripts/check-collaboration-schema.ts` (post-P0-14 structural only) | C | KEEP — validating immutable migration text is legitimate forever |
| Branding negation | `tests/app.test.ts:120-128` | Product guard | KEEP — this is the test that makes G-class regressions fail CI |
| Fresh-setup origin retirement fixtures | `tests/bootstrap/*`, `tests/taxonomy/p0-14-database.test.ts` | E | KEEP — they prove the seed-retirement gates |

## Migration Findings

| Item | Location | Classification | Recommended Action |
| --- | --- | --- | --- |
| Origin seed rows (9 divisions, 1 rule, mapping dictionaries, preference columns) | `202608290001`, `202608290002`, `202608290003`, `202608290005`, `202608260001` | A | **MUST NOT modify.** Ship in the archive (required by the migrate gate); fresh installs retire the exact seed under provenance (P0-14), legacy installs keep it |
| `gwens_*` advisory-lock keys | as listed in Branding | A | **MUST NOT modify** — lock identity is a serialization contract |
| `202609080001`/`202609090001`/`202609090002` | applied/committed identities | A | Immutable (P0-12 incident constraint; D-014) |
| Origin literals inside `202609090002` (retirement set) | exact `(code,name)` pairs used by `provision_first_installation` | A | Immutable — these literals are the retirement safety gate, not leaked branding |
| `WHATSAPP` channel value | `202609010002:26,62` | A | KEEP — reserved value, DEFER enablement |

## Legacy Compatibility Findings

Items that remain temporarily and must be explicitly documented as such (most already are):

1. `gwens` deployment identifier family — supported overrides for the existing installation; documented `vps-production.md:44-55`.
2. `gwens-admin-key` browser storage key — documented `README.md:36`.
3. `GWENS_LEGACY_SCHEMA_V1` + fixture — schema-contract checker input.
4. `gwens_*` advisory locks — D-013; documented in README legacy paragraph and ADRs.
5. Legacy display-name dictionary (SQL ×2 + TS ×1) and `UNASSIGNED` sentinel — P0-13 ADR Legacy Identity Transition; retire at post-v1 contract stage.
6. `AFFILIATE_TASK_STATUS` alias chain — lineage-gated; removed at v1.1 per P0-13 ADR.
7. `telegram_users.legacy_telegram_user_id` + display columns — reconciler compatibility.
8. Origin-domain notification types — live n8n contract until P2-01/P2-03.
9. `supabase/config.toml` project id `gwensoto` — identity of the developer's linked Supabase project; see the packaging caveat below.
10. `LOCAL_GWENS_POLLING`/`VPS_GWENS_POLLING` names — **stale**: no code accepts them anymore; the real variable is `TELEGRAM_POLLING_ENABLED`. Update AGENTS.md wording; this is a doc fix, not a compatibility item.

## Dead-State Candidates

1. `src/governance/catalog.ts` `DIVISION_SEEDS` — zero runtime importers (only checker + test). Not delete-while-checkers-use-it, but relocate/relabel. (F)
2. `AGENTS.md:42,50` polling variable names — reference identifiers that exist nowhere in code. (F)
3. `README.md` stale behavioral claims (idempotency, ADMIN_API_KEY optionality, manual migration step). (F inside a D file)
4. `docs/architecture/target-domain-model.md:21` seed-code claim; `implementation-roadmap.md:71` origin criterion; `reporting-owner-console.md` canonical-alias framing. (F inside C files)
5. `tmp/` — empty, gitignored. No action.

## Customer Package Exposure

Actual archive contents per `scripts/deploy/package-release.ps1:22`: `dist/src`, `public`, `package.json`, `package-lock.json`, `.node-version`, `scripts/migrate.ts`, `scripts/deploy/deployment-config.sh`, `scripts/deploy/check-vps-runtime.mjs`, `supabase/config.toml`, `supabase/migrations`.

| File | Customer Package? | Reason |
| --- | --- | --- |
| `dist/src/` | Yes (runtime) | Clean — no origin literals in runtime code |
| `public/` | Yes (UI) | Clean; brand-guarded by test |
| `package.json`, `package-lock.json`, `.node-version` | Yes | Clean |
| `scripts/migrate.ts`, `deployment-config.sh`, `check-vps-runtime.mjs` | Yes (deploy tooling) | Clean |
| `supabase/migrations/` | Yes (migrate gate requires them) | Contains origin seed SQL — **accepted**: immutable history; fresh installs retire the seed; cannot be cleaned without breaking the registry |
| `supabase/config.toml` | Yes today | **Exposure**: `project_id = "gwensoto"`. Verify whether `migrate.ts` consumes this file or relies solely on deploy-only link state (AI_HANDOFF says link state comes from protected env vars); if unused, exclude from the archive; if needed, generate a neutral placeholder at package time. Do not silently change the developer's local linked-project config |
| `README.md` | Ships in Git, not in archive; customer-visible as repo entry | Clean up (D-class) |
| `docs/go-live-*.md`, `beta-readiness.md`, `docs/adr/`, `docs/reviews/`, `docs/plans/`, `AGENTS.md`, `AI_*.md`, `DECISIONS.md`, `ROADMAP.md`, `SOTOAYAM_PRD.md` | **No** — internal engineering repository only | Already excluded from the archive; keep it that way (the packaging allowlist structure makes accidental inclusion unlikely — preserve the allowlist style) |
| `docs/database-recovery.md`, `docs/integrations/*`, `docs/architecture/*`, `presets/` | Not in the archive today; intended customer/operator material per P0-16 | Minor cleanup (dump filename); otherwise include in the P0-16 customer doc set |

## Safe-To-Change Matrix

| Item | Change Now | Keep | Why |
| --- | --- | --- | --- |
| `README.md` factual claims + example | Yes | — | Doc-only; current text is false and origin-flavored |
| `supabase/config.toml` in archive | Yes, with verification | — | Packaging change; must first confirm `migrate.ts`/deploy flow does not read it; never edit the developer's linked config itself |
| `docs/database-recovery.md` dump name framing | Yes | — | Doc-only |
| Architecture docs stale claims (4 files) | Yes | — | Doc-only; align with P0-14 truth |
| `cross-division-rules-v1.md` example framing | Yes | — | Doc-only |
| `AGENTS.md` polling variable wording | Yes | — | Doc-only; names exist nowhere in code |
| `src/governance/catalog.ts` relocation/relabel | Yes (mechanical, low risk) | — | Checker imports update with it; no runtime path |
| Fixture header labels | Yes | — | Comment-only |
| `gwens` deployment identifiers | — | Yes | Live-install compatibility; renaming requires a coordinated cutover (already documented) |
| `gwens-admin-key` storage key | — | Yes | Browser-state orphaning risk |
| `GWENS_LEGACY_SCHEMA_V1` | — | Yes | Named contract consumed by checker |
| `gwens_*` advisory locks | — | Yes | Lock identity = serialization correctness |
| Legacy dictionary + `UNASSIGNED` | — | Yes | Runtime fallback for existing installs; retirement is a later contract stage |
| `AFFILIATE_TASK_STATUS` alias chain | — | Yes (until v1.1) | Lineage-gated contract; removal is P2-05 |
| Notification type enum | — | Yes | Live integration contract; P2-01/P2-03 scope |
| Historical migrations | — | Yes | Immutable identities (registry + remote application) |
| ADR/review/go-live history documents | — | Yes | Audit trail; exclude from customer material, never delete |

## Historical Immutable Items

P0-15 must NOT modify:

1. All 15 files in `supabase/migrations/` — including every origin seed literal, the `gwens_*` lock keys, and the origin `(code,name)` retirement pairs inside `202609090002`.
2. Git history, including the `chore: establish gwens automation baseline` commit subject.
3. `installation_provenance`, `instance_bootstrap`, and `audit_logs` semantics — the append-only history that references origin rows (including the `migration_seed` collaboration-rule audit row) is evidence, not cleanup material.
4. The advisory-lock key `gwens_system_admin_invariant` as referenced by `scripts/check-first-admin-bootstrap.ts:30` and `scripts/check-user-management.ts:16` (checker text mirrors migration text; both stay).
5. The exact retirement set (9 divisions + 1 rule) in `provision_first_installation` — origin words here are the safety gate.

## Runtime Compatibility Items

Temporarily retained, each with its documented exit stage:

1. `gwens` deployment identifiers — existing-install overrides (exit: coordinated cutover, not scheduled).
2. `gwens-admin-key` browser key (exit: coordinated browser-state migration, post-v1).
3. `GWENS_LEGACY_SCHEMA_V1` + fixture (exit: when the schema-contract checker is retired).
4. Legacy display dictionary + `UNASSIGNED` + `telegram_users` display columns (exit: post-v1 contract stage per P0-13 ADR).
5. `AFFILIATE_TASK_STATUS` alias chain (exit: v1.1, P2-05).
6. Origin-domain notification types (exit: P2-01/P2-03 configurability).
7. `supabase/config.toml` project id as the developer's local link identity (exit: when packaging stops shipping it — P0-15 target).
8. Legacy staged-runtime checker (`check-legacy-staged-runtime.mjs`) (exit: when the origin installation is decommissioned).

## Customer-Facing Cleanup Required

1. **`README.md`** — replace the origin product example; correct the three stale behavioral claims (idempotency implemented in P0-06; `ADMIN_API_KEY` mandatory at startup ≥32 chars since P0-03; migrations run via `npm run migrate`); reword the legacy-identifier paragraph to address installers/operators rather than "workspace lama" framing. (D + F)
2. **Release archive** — stop shipping `supabase/config.toml`'s origin project id: verify consumption, then exclude or generate a neutral file at package time. (D-class exposure of a B value)
3. **`docs/database-recovery.md:95`** — present the historical dump filename as a historical example, or drop the specific name from the customer-relevant runbook. (C→D minor)
4. **`docs/integrations/*`** — keep; ensure P0-16 presents them as product integration material (they are already origin-free).

## Internal-Only Cleanup Required

1. `docs/architecture/target-domain-model.md:21` — update seed-code claim to post-P0-14 truth. (F)
2. `docs/architecture/implementation-roadmap.md:71` — reframe origin acceptance criterion. (F)
3. `docs/architecture/reporting-owner-console.md` — reframe alias vs canonical `TASK_STATUS`. (F)
4. `docs/architecture/cross-division-rules-v1.md:32` — reframe origin rule as historical example. (C)
5. `AGENTS.md:42,50` — replace `LOCAL_GWENS_POLLING`/`VPS_GWENS_POLLING` wording with `TELEGRAM_POLLING_ENABLED` (or mark historical). (F)
6. `src/governance/catalog.ts` — relabel as a historical-migration fixture (or move beside `check-governance-foundation.ts`). (F)
7. Test fixtures — add explicit "legacy-compatibility fixture" labels where missing. (E labeling)
8. Optionally group the five `go-live-*` workbooks + `beta-readiness.md` under an internal-only docs subfolder to make the internal/customer split self-evident before P0-16. (C organization)

## P0-15 Recommended Scope

**MUST CLEAN NOW** (customer-visible or factually false):
1. `README.md` stale claims + origin product example + operator framing of legacy identifiers.
2. `supabase/config.toml` exclusion/neutralization from the release archive (after verifying `migrate.ts` link-state flow).
3. `docs/database-recovery.md` dump-filename framing.

**SHOULD CLEAN** (internal truthfulness, low risk):
4. Four stale architecture-doc claims (target-domain-model, implementation-roadmap, reporting-owner-console, cross-division-rules-v1 framing).
5. `AGENTS.md` polling-variable wording.
6. `src/governance/catalog.ts` relabel/relocation.
7. Fixture legacy labels.

**KEEP LEGACY** (do not touch): all `gwens` compatibility identifiers, advisory locks, legacy dictionary, alias chain, notification enum, historical migrations, Git history, ADR/review/go-live records.

**DEFER**: WhatsApp enablement; notification-type configurability (P2-01/P2-03); alias removal (v1.1/P2-05); legacy-dictionary retirement (post-v1 contract stage); browser-key migration; internal-docs subfolder reorganization if it would churn P0-16's doc set (fold into P0-16 instead); Hermes mentions in deploy guide (safety text — reword only if P0-16 rewrites the guide anyway).

## Risks

1. **Packaging change is the only finding with runtime consequence.** Excluding `supabase/config.toml` could break `npm run migrate` on the VPS if the Supabase CLI expects a config file in the working directory. AI_HANDOFF states deployment establishes link state from protected deploy-only env vars and removes it after migration — this must be re-verified by reading `deploy-release.sh`/`migrate.ts` before the packaging change, and covered by a deployment test.
2. **README rewrite touches the legacy-identifier paragraph** — it is the only place telling an operator not to rename those values; the rewrite must preserve that warning.
3. **Renaming anything in the `gwens` family** would break the existing installation, browser sessions, or serialization — explicitly out of scope.
4. **Deleting internal history** (go-live workbooks, ADRs, reviews) would destroy the audit trail that justifies compatibility decisions; the correct action is exclusion from customer material, not removal.
5. **Over-eager fixture cleanup** could weaken intentional legacy-compatibility coverage; fixtures change only by labeling.
6. **Doc drift risk**: once README is corrected, P0-16 will produce the authoritative install guide; keep README pointing to it to avoid two diverging instructions.

## Acceptance Criteria for P0-15 Implementation

1. `grep -i "squishy\|strawberry"` returns zero hits; README makes no claim contradicting P0-03/P0-06/P0-07 behavior; README's legacy-identifier paragraph survives in operator framing.
2. A fresh release archive built by `package-release.ps1` contains no `gwensoto` string (`tar -tzf` + content grep), while `npm run migrate` still passes in a disposable environment using the deploy-only link-state flow; `tests/deployment/*` updated to cover the packaging change.
3. `npm run check:secrets` passes; no secret or personal data introduced or exposed.
4. All 15 migration files byte-identical (`git diff -- supabase/migrations` empty; the SHA-256 integrity test still passes).
5. No `gwens` runtime identifier renamed: `public/app.js` storage key, deployment identifiers, advisory-lock keys, `GWENS_LEGACY_SCHEMA_V1` unchanged; `tests/app.test.ts` branding guard still passes.
6. The four stale architecture claims corrected; `AGENTS.md` polling wording fixed; no doc claims origin taxonomy is a fresh-install default or that the alias is canonical.
7. Typecheck, build, full test suite, contract tests pass; working tree contains only the intended doc/packaging changes.
8. The customer-package boundary is explicit: the archive allowlist in `package-release.ps1` unchanged except for the config.toml decision, with a comment recording why.

## Recommended File Change List

1. `README.md` — rewrite stale sections + neutral example + operator framing (MUST).
2. `scripts/deploy/package-release.ps1` — exclude or neutralize `supabase/config.toml` after verifying the migrate flow (MUST, with deployment-test update in `tests/deployment/`).
3. `docs/database-recovery.md` — generalize the historical dump filename (MUST, one line).
4. `docs/architecture/target-domain-model.md` — update line 21 seed claim (SHOULD).
5. `docs/architecture/implementation-roadmap.md` — update line 71 criterion (SHOULD).
6. `docs/architecture/reporting-owner-console.md` — reframe canonical report (SHOULD).
7. `docs/architecture/cross-division-rules-v1.md` — reframe origin example (SHOULD).
8. `AGENTS.md` — fix polling variable wording, lines 42/50 (SHOULD).
9. `src/governance/catalog.ts` — add historical-fixture header comment or relocate with checker import update (SHOULD).
10. Fixture header labels in the tests listed under Test Fixture Findings (SHOULD, comment-only).
11. `tests/deployment/package-release.test.*` (new or extended) — assert no origin project id in the built archive (SHOULD).
