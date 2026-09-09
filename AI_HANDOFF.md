# SOTOAYAM AI HANDOFF
Purpose: short-lived cross-agent operational memory. Keep this concise. Replace stale task details rather than growing indefinitely.

## Current Product State
Audit completed on 2026-09-07 against commit `bd5fdd3`.

Audit verdict: not commercially ready, but core architecture is fundamentally sound.

Baseline at audit:
- ~6,400 LOC TypeScript
- 12 migrations
- 23 tables
- 390 tests passing
- strict typecheck clean
- secret scan clean

## What Must Be Preserved
- Supabase service-role access model.
- RLS deny-all posture.
- SECURITY DEFINER restrictions.
- reminder dedupe and scheduler lease.
- delivery state machine.
- route/service/repository layering.
- existing migration history unless a migration-specific task says otherwise.

## Admin Authorization State
SEC-001 is patched and all 11 admin route groups now use the centralized fail-closed scope in `src/auth/admin-authorization.ts`.

Permanent route-level regression coverage verifies all 11 groups for missing configuration, missing/wrong request keys, and matching keys. Startup configuration requires `ADMIN_API_KEY` and rejects values shorter than 32 characters.

New admin route groups must use `defineAdminRoutes` and be added to the security manifest. Admin API-key checks must not be implemented locally in route files.

## Notification Intake State
`POST /api/notifications/send` now persists caller event identity and atomically expands recipient notifications and routed deliveries through `intake_notification_event` before Telegram side effects. `(source, external_event_id)` is the authoritative database idempotency key. Identical retries return the stored synchronous result without rebroadcasting; conflicting payload reuse returns `409 NOTIFICATION_EVENT_CONFLICT`.

External routed deliveries reuse the existing claim, retry/backoff, permanent-failure, and stale-recovery machinery. Missing `event_id` remains legacy-compatible and explicitly non-idempotent. Implementation-time reconciliation was complete: 5 normalized users, 5 Telegram-linked users, 5 mapped, 0 unmapped.

## First Administrator Bootstrap and Taxonomy State
P0-11 through P0-14 are implemented. `npm run setup` is the supported first-administrator bootstrap command and executes compiled `dist/src/cli/setup.js` after production dependency pruning.

Bootstrap eligibility is enforced by database state under the existing system-authority advisory lock: no permanent bootstrap marker, no historical authority assignment (including revoked rows), and no administrator credential. The transaction atomically creates one active normalized user, one scrypt credential, one `SYSTEM_ADMIN` assignment, the singleton marker, and one sanitized audit record. It cannot re-arm automatically and is not a recovery path.

Setup now requires an explicit, mutually exclusive `--fresh-install` or `--keep-existing-taxonomy` declaration (or the equivalent interactive choice), prints a read-only preview before collecting the password, and requires a division choice. Fresh setup accepts a customer-owned division code/name and retires the exact unreferenced origin seed only inside the locked provisioning transaction; any operational evidence vetoes retirement. Legacy setup binds the first administrator to an existing active division. Telegram is not required, the role remains `ADMIN`, and the administrator never receives `OWNER`.

`installation_provenance` is an append-only singleton. `FRESH` disables the historical report alias; absent provenance is treated as `UNKNOWN` and therefore legacy-compatible. Divisions and task categories are data-backed, arbitrary active task categories validate across canonical write paths, and generic task-status reporting accepts division/category/status/time-window filters. The three baseline roles remain system-managed; only display-name rename is exposed. Custom roles and permission-grant editing remain out of scope.

Provenance is read once during application startup. A fresh instance necessarily starts before setup with absent/`UNKNOWN` provenance and may register the benign legacy report alias for that first process lifetime; restart the service after successful fresh setup so `FRESH` route registration takes effect. Authorization and provisioning safety do not depend on that alias.

`SYSTEM_ADMIN` eligibility no longer depends on the literal `IT` taxonomy. It requires an active authority assignment, active user/division, and the division's guarded `grants_system_authority` capability. Direct service-role capability writes and removal of the last post-bootstrap capable division are rejected. HTTP administrator access still uses centralized `ADMIN_API_KEY` authorization until P1-01 implements sessions.

P0-14 adds exactly one forward migration, `202609090002_implement_customer_taxonomy_transition.sql`, bringing the repository total to 15. All 14 historical migration hashes remain unchanged. Validation used only disposable local PostgreSQL: 17 database tests passed explicitly; the full suite with one worker passed 602 tests and skipped those same 17 opt-in database tests. The default parallel suite hit only pre-existing 5-second Windows shell-startup timeouts in two deployment test files; both files pass in isolation. Typecheck, build, contract tests, secret scan, and diff checks passed. No live Supabase project or VPS was contacted.

Operational incident during P0-12 validation: a local mock intended for `npm run migrate` was shadowed by npm's real local Supabase CLI. The existing linked project applied `202609080001_create_notification_event_intake.sql` and `202609090001_create_first_admin_bootstrap.sql`. No setup/bootstrap RPC was called and no VPS deployment occurred. Do not rename or rewrite those applied migration files; reconcile the linked migration registry before any future migration operation.

## Migration State
One official ordered migration command exists: `npm run migrate`. It validates the repository migration inventory, then uses the established Supabase CLI migration registry to apply pending migrations in deterministic filename order.

`npm run migrate` is the required migration entry point and is now a mandatory pre-activation gate in `scripts/deploy/deploy-release.sh`. Migration failure prevents the release symlink from changing or the service from restarting. Deployment installs the pinned CLI only in the inactive release, establishes link state from protected deploy-only environment variables, then removes CLI link state and development tooling before activation.

Application rollback and database migration rollback are distinct. The existing application rollback can atomically select the previous compatible release; database migrations remain forward-only and are never reversed automatically.

Fresh-install deployment identity and paths are parameterized through the shared `scripts/deploy/deployment-config.sh` contract. `DEPLOY_USER` is explicit; fresh defaults use `/opt/sotoayam`, the `sotoayam` service account/group, and `sotoayam.service`. Existing installations can continue supplying compatibility-sensitive legacy identifiers without renaming active resources.

`.node-version` is the authoritative deployment runtime pin. Bootstrap installs the exact supported Node.js version and release deployment rejects any different runtime before dependency installation or activation.

Fresh-customer installation defaults are separated from the historical staged cutover. Fresh runtime validation now checks configuration shape, the exact Node.js pin, and generic localhost health without requiring origin-company users, Divisi, roles, collaboration rules, or row counts. Historical business-data validation remains available only through an explicitly legacy, opt-in checker that is excluded from fresh release archives.

Operational worker flags remain explicit customer choices: safe preparation values do not silently enable Telegram polling, reminders, or critical-alert evaluation, and fresh installation no longer forces the original all-disabled cutover state. The fresh host and business-timezone fallbacks are `127.0.0.1` and `UTC`; existing installations retain compatibility through explicit environment values.

Historical operational assumptions are not universal product requirements. P0-14 moved customer taxonomy to data while retaining provenance-gated compatibility. P0-15 removed the origin-linked `supabase/config.toml` from the customer release archive, corrected stale customer/operator guidance, labeled origin go-live records as internal historical evidence, and moved the origin division list out of runtime source into a checker fixture. The developer-local config remains in the repository, while all 15 migrations and compatibility-sensitive deployment, browser-storage, schema-contract, advisory-lock, reporting-alias, and legacy-identity identifiers remain unchanged.

The release package allowlist now contains migration tooling and all migrations but no developer Supabase project identity. Deployment still creates link state from protected deploy-only environment variables; its test passes with no packaged `config.toml`. P0-15's required validation passed 605 tests with 17 opt-in disposable-database tests skipped, plus typecheck, build, contract tests, secret scan, focused packaging/deployment tests, a real archive content check, historical migration integrity, and diff whitespace validation. No live Supabase project or VPS was contacted. An additional `npm run check:governance-schema` run remains red on the pre-existing `PERMISSION_SEED` and `OWNER_GRANTS` comparisons because that historical-migration checker imports the later-expanded current permission catalog; the P0-15-relocated `DIVISION_SEED` comparison passes, and neither failing branch nor any migration was changed in this task.

## Next Agent
Recommended: Claude Code.

Next task:
Author P0-16's clean installation guide against the now-clean customer package and current explicit setup flow.

Reason:
P0-15 implementation and all local gates are green. The remaining Phase 0 documentation task is a clean installation guide, followed by Antigravity dry-run validation.

## Pending Higher-Level Work
- Write and validate the clean installation guide (P0-16).
- Keep identity-based admin sessions, rate limiting, integration credentials, and other Phase 1 work outside P0-16.

## Agent Handoff Format
Every agent completing a task should return:

### Completed
What changed.

### Validation
Commands/tests run and results.

### Decisions
Any new decision that changes architecture or product behavior.

### Risks / Remaining
Anything unresolved or intentionally deferred.

### Next Recommended Task
Exactly one next step where possible.

The orchestrator will decide whether that recommendation is accepted.
