# P0-15 Adversarial Review

## A — RELEASE PACKAGE
**PASS.** `supabase/config.toml` has been successfully excluded from the customer release archive in `scripts/deploy/package-release.ps1`. The deployment migrate flow continues to function properly without the developer-linked config file, and no new dependencies were introduced. A deployment test was added in `deploy-release.test.ts` to assert this packaging change.

## B — HISTORICAL MIGRATION INTEGRITY
**PASS.** Exactly 15 migration files remain in `supabase/migrations/`. No migration files were altered. Integrity tests and the migration baseline checker passed, verifying that historical schema identities and legacy locks (`gwens_*`) are preserved byte-identical.

## C — README ACCURACY
**PASS.** The `README.md` was correctly scrubbed. The "Stok Squishy Strawberry kritis" origin example was replaced with a neutral SKU example. False behavioral claims regarding idempotency, ADMIN_API_KEY optionality, and migration steps were corrected. The legacy compatibility section was thoughtfully preserved and reframed for operators, warning them against removing legacy identifiers.

## D — BRAND / ORIGIN PACKAGE LEAKAGE
**PASS.** `grep -i "squishy\|strawberry"` returns zero hits across the repository. The literal `gwensoto` remains only in the local `supabase/config.toml` (which is correctly excluded from the release archive) and in internal audit/inventory documentation, properly satisfying the customer package boundary.

## E — COMPATIBILITY IDENTIFIERS
**PASS.** `gwens` deployment identifiers in `vps-production.md`, `gwens-admin-key` in browser storage, `GWENS_LEGACY_SCHEMA_V1` in checkers, advisory locks in migrations, legacy display mappings in `src/identity/legacy-mapping.ts`, and the `AFFILIATE_TASK_STATUS` alias chain remain completely unmodified to support the existing live installation.

## F — DIVISION_SEEDS RELOCATION
**PASS.** The dead runtime fixture `DIVISION_SEEDS` was safely relocated from `src/governance/catalog.ts` to `scripts/fixtures/legacy-governance-foundation.ts` as `LEGACY_DIVISION_SEEDS`, removing it from the application payload while successfully maintaining the governance checker support.

## G — AGENTS.MD
**PASS.** The stale `LOCAL_GWENS_POLLING` and `VPS_GWENS_POLLING` names were correctly removed from `AGENTS.md` and replaced with the actual implementation variable, `TELEGRAM_POLLING_ENABLED`.

## H — INTERNAL DOC CLEANUP
**PASS.** Architecture documents (`target-domain-model.md`, `implementation-roadmap.md`, `reporting-owner-console.md`, `cross-division-rules-v1.md`) were successfully updated to reflect post-P0-14 truth. All origin framing was converted to explicit historical context notes.

## I — CUSTOMER PACKAGE BOUNDARY
**PASS.** All internal origin engineering documentation (`docs/go-live-*.md`, `beta-readiness.md`, `docs/adr/`, etc.) remains strictly excluded from the release packaging workflow in `scripts/deploy/package-release.ps1`. They are internal to the repository, not the shipped customer package.

## J — SOURCE / RUNTIME SAFETY
**PASS.** The application remains completely brand-clean. No origin words breached the product runtime boundary. The `tests/app.test.ts` branding guard successfully asserts the correct `Sotoayam` branding.

## K — GOVERNANCE CHECKER DRIFT
**VERIFIED.** The drift where `npm run check:governance-schema` fails on `PERMISSION_SEED` and `OWNER_GRANTS` is confirmed present. As instructed, this drift was only verified and not fixed during the review.

## L — RELEASE ARCHIVE CONTENT
**PASS.** The built release archive contains no `gwensoto` string. The change to `package-release.ps1` explicitly prevents the developer's local Supabase configuration from bleeding into the archive payload, resolving the primary D-class leak.

## M — SECURITY / DATA LEAKAGE
**PASS.** `npm run check:secrets` passes cleanly. No secret, token, personal data, or new credentials were inadvertently exposed or modified.

## N — TEST QUALITY
**PASS (with minor note).** The agent correctly introduced `tests/commercial/origin-state-cleanup.test.ts` to enforce the new cleanup state programmatically. Note: the optional "legacy-compatibility fixture" header comments (a SHOULD task) were not added to existing test files, but this omission does not compromise P0-15 integrity.

## O — FULL VALIDATION
**PASS.** `npm run typecheck`, `npm run build`, `npm run test:contract`, and the full test suite (`npm test -- --maxWorkers=1`) executed successfully without failures or regressions.

## P — REMAINING GWENS OCCURRENCES
**PASS.** Any remaining instances of `gwens` or `GWENS` are correctly localized to legacy compatibility configurations, historical migrations, internal document audit trails, or deployment contracts explicitly marked for existing installation support.

## Q — SCOPE CONTROL
**PASS.** The agent correctly constrained its modifications to documentation and packaging changes. It did not blindly run destructively against production code, it did not alter immutable migration SQL, and it correctly abstained from creating commits or interacting with the live DB/VPS.

## CONCLUSION
**P0-15 MAY PROCEED.** The customer-facing origin-state leakage has been effectively neutralized without introducing regressions or breaking the existing installation contracts.

