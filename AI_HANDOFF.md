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
P1-01 is implemented. All 12 admin route groups use the centralized fail-closed scope in `src/auth/admin-authorization.ts`, which resolves an opaque database-backed administrator session first and then the temporary Stage A `ADMIN_API_KEY` compatibility fallback. Session tokens and CSRF tokens are 256-bit random values stored only as SHA-256 hashes. Sessions have 12-hour absolute and 1-hour idle defaults, immediate revocation, a ten-session cap, CSRF enforcement on mutations, account/IP cooldown gates, and audited lifecycle events.

The browser uses same-origin `HttpOnly`, `Secure`, `SameSite=Strict` session cookies and no longer receives or stores the shared key. `SESSION_COOKIE_SECURE=false` is allowed only on loopback with `TRUST_PROXY=false`. Session principals resolve the exact authenticated administrator and recheck active `SYSTEM_ADMIN` authority/capability on actor-protected routes, so two active system administrators no longer trigger the singleton failure. OWNER actor semantics remain intentionally unchanged for P2-01.

`ADMIN_API_KEY` remains required with its 32-character minimum and works across all 12 groups while `ADMIN_API_KEY_FALLBACK_ENABLED=true`; fallback use is logged and audited once per process. `npm run admin:reset-password -- --email <address>` is the server-only recovery path and revokes all sessions for that account.

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

`SYSTEM_ADMIN` eligibility no longer depends on the literal `IT` taxonomy. It requires an active authority assignment, active user/division, and the division's guarded `grants_system_authority` capability. Direct service-role capability writes and removal of the last post-bootstrap capable division are rejected. P1-01 session actor resolution preserves and re-evaluates this boundary on every protected request.

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

Historical operational assumptions are not universal product requirements. P0-14 moved customer taxonomy to data while retaining provenance-gated compatibility. P0-15 removed the origin-linked `supabase/config.toml` from the customer release archive, corrected stale customer/operator guidance, labeled origin go-live records as internal historical evidence, and moved the origin division list out of runtime source into a checker fixture. The developer-local config remains in the repository. P1-01 deliberately retired the legacy browser shared-key storage identifier; other compatibility-sensitive deployment, schema-contract, advisory-lock, reporting-alias, and legacy-identity identifiers remain unchanged.

The release package allowlist now contains migration tooling and all migrations but no developer Supabase project identity. Deployment still creates link state from protected deploy-only environment variables; its test passes with no packaged `config.toml`. P0-15's required validation passed 605 tests with 17 opt-in disposable-database tests skipped, plus typecheck, build, contract tests, secret scan, focused packaging/deployment tests, a real archive content check, historical migration integrity, and diff whitespace validation. No live Supabase project or VPS was contacted. The pre-existing governance checker drift was subsequently reconciled without changing migrations or permission semantics: it now reconstructs foundation plus later permission/grant additions, and all governance checks pass.

## P0-16 Clean-Room Rehearsal State

P0-16 and Phase 0 are complete. `docs/deployment/clean-install.md` is the customer/operator guide and `docs/reviews/P0-16-clean-install-rehearsal.md` records the complete evidence.

The release packaging fixes remain in the working tree: production-only installs use compiled `dist/scripts/migrate.js`, and the customer archive includes `.env.example` plus the installation and recovery guides while excluding developer Supabase identity and internal reviews.

F-001 is resolved with an authorized disposable hosted Supabase target. The linked target and supplied target credentials agreed, its migration registry exactly matched all 15 local versions, and its public application schema contained the expected 28 tables. A data-only backup was restored deterministically by truncating all 28 application tables together without `CASCADE`, then applying the dump in the same transaction without disabling triggers. The committed restored state contained one `FRESH` provenance record, active `OPERATIONS`, one bootstrap marker, the active first administrator with `ADMIN`, an active `SYSTEM_ADMIN` assignment, and its credential record. A Node 24.20.0 application process configured only for that restored target returned `/health` HTTP 200 with Telegram polling, reminders, and critical-alert evaluation disabled, then shut down cleanly.

No historical migration changed. The P0-16 restore acceptance contacted only the authorized disposable hosted target; no VPS or Telegram API was contacted. Disposable credentials are not stored in the repository. During closeout, the optional repository `check:migration-baseline` command also ran its built-in Supabase diagnostic and reversible-write check against the repository-configured environment; every substantive subcheck reported PASS and the reversible check cleaned up, while the aggregate command reported FAIL only because its source-control check requires a clean working tree.

Final closeout validation passed: 612 tests passed with 17 documented opt-in database tests skipped, typecheck and build passed, all 9 contract tests passed, all 13 governance checks passed, and the final secret scan passed. Disposable credential values discovered in the uncommitted `.env.example` were removed; the file now contains blank template values only.

## P1-01 Validation State

One additive migration, `202609100001_create_admin_session_authentication.sql`, brings the repository total to 16. All 15 historical migration hashes remain unchanged. A clean isolated PostgreSQL 17 database applied 16/16 migrations, and six focused database tests passed for service-only RPC access, hash validation, touch throttling, immediate revocation, consecutive-failure cooldown, password-change revocation, idle/absolute expiry, deactivation, session cap, and audit lifecycle. The default full suite passed 647 tests with 23 documented opt-in database tests skipped; focused unit/route coverage includes 60 authorization matrix cases across all 12 groups and the two-administrator regression. Typecheck, build, nine contract tests, secret scan, governance checks, and diff checks passed. No remote Supabase project, VPS, Telegram API, or production data was contacted.

## P1-02 Outbound HTTP State

All production outbound HTTP now passes through `OutboundHttpClient`; Telegram sending, editing, callback acknowledgement, startup checks, and long polling no longer call `fetch` directly. Each attempt has an explicit timeout, safe reads have at most two retries (three attempts), and final failures carry stable timeout/network/HTTP/abort classification with attempt and exhaustion metadata. Retry waits observe caller cancellation immediately.

Telegram mutation POSTs are never retried after ambiguous timeout, network, or 5xx outcomes. They retry only explicit HTTP 429 rejection. When both HTTP `Retry-After` and Telegram `parameters.retry_after` are valid, the longer delay wins; a server delay above the 60-second local wait cap is returned unchanged in deterministic error metadata without retrying early. Polling request failures exhaust the same bounded client policy rather than entering an unbounded error-retry loop. Existing `TELEGRAM_*_FAILED` application error contracts and notification batch accounting remain intact. No migration or runtime dependency was added.

## Next Agent
Recommended: Codex implementation for P1-03.

Next task:
Implement P1-03 rate limiting for auth-bearing routes.

Reason:
P1-01 and P1-02 are complete with full-suite evidence. P1-03 is the next ordered Phase 1 security item.

## Pending Higher-Level Work
- Continue Phase 1 with P1-03 auth-route rate limiting; preserve the P1-01 session and P1-02 outbound HTTP boundaries.
- Preserve remaining launch gates: Phase 4 clean-room install, upgrade/rollback, restore drill, and final security review are still separate pre-customer requirements.

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
