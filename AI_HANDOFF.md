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

The browser uses same-origin `HttpOnly`, `Secure`, `SameSite=Strict` session cookies and no longer receives or stores the shared key. `SESSION_COOKIE_SECURE=false` is allowed only on loopback with `TRUST_PROXY=false`. Session principals resolve the exact authenticated user. System-administration routes recheck active `SYSTEM_ADMIN` authority/capability; P2-01 OWNER/settings routes instead enforce their exact business permissions.

`ADMIN_API_KEY` is optional by default and is accepted only when `ADMIN_API_KEY_FALLBACK_ENABLED=true`; when present it retains its 32-character minimum. P2-01 excludes it from settings and OWNER mutations and restricts OWNER reads to the designated eligible business actor. Explicit fallback enablement requires the key, logs a deprecation warning at every startup, and logs/audits use once per process. `npm run admin:reset-password -- --email <address>` is the server-only recovery path and revokes all sessions for that account.

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

## P1-03 Rate-Limit State

Application-level rate limiting is implemented as dependency-free, in-process token buckets with continuous refill, bounded keys, sweep-then-LRU eviction, unreferenced sweep timers, and Fastify close cleanup. Route policy is structural: all 12 `defineAdminRoutes` groups inherit read/write policy, special auth/expensive/internal routes declare explicit policies, and health/static routes are exempt. Session admin budgets use `adminUserId`, compatibility fallback uses one `apikey` identity, auth session reads are fixed at 120/minute, and current-password changes are fixed at 5 per 15 minutes.

Every completed 401 charges a per-IP auth-failure bucket. Later credential requests inspect that bucket before handlers, database calls, or scrypt; exhausted sources receive `RATE_LIMITED`. A limiter 429 never reaches P1-01 login work and never creates a P1-01 failure. Limiter faults fail open while authentication remains fail-closed. Loopback plus `TRUST_PROXY=false` emits a warning and multiplies only IP budgets; no localhost or `ADMIN_API_KEY` exemption exists. Counters reset on restart by design, while durable login cooldown remains database-backed.

P1-03 validation passed 58 focused tests and the full 699-test active suite, with 24 documented database tests skipped by default. Typecheck, build, nine contract tests, secret scan, governance checks, historical migration integrity, and diff checks passed. No migration or production dependency was added.

## P1-04 Integration Credential State

Per-integration machine credentials are implemented for internal task ingestion and notification intake. Credentials use an 80-bit selector plus a 256-bit opaque secret; only the SHA-256 secret digest is stored. Authentication executes through a service-role-only SECURITY DEFINER RPC on every request, resolves the owning integration and division, enforces required capability, and uses the existing P1-03 integration identity budget. `X-Integration-Code` is only an optional consistency assertion and never authenticates by itself.

SYSTEM_ADMIN session routes and the server-side CLI provide create, metadata-only list, immediate/grace revoke, and rotation workflows. The CLI requires `--email` to select an active SYSTEM_ADMIN explicitly and remains valid with multiple administrators. Grace is monotonic: it cannot reactivate expired credentials or extend future expiry, while immediate revocation always overrides it. At most two credentials may be active per integration under the shared advisory lock. Lifecycle audit rows contain selector metadata but never raw credentials or digests. Notification attribution uses the new nullable `integration_id` while preserving `notification_events.source` and `(source, external_event_id)` idempotency exactly.

The `INTERNAL_API_KEY` Stage A fallback remains enabled by default for zero-downtime upgrades and is observed once per process. `ADMIN_API_KEY` Stage B is now optional with its fallback disabled by default; operators can temporarily opt in, with startup deprecation warnings and usage checkers supporting removal evidence. One additive migration, `202609110001_create_integration_credentials.sql`, brings the repository total to 17 and preserves all 16 historical hashes. Focused disposable PostgreSQL validation applied 17/17 migrations and passed all 17 integration-credential database tests.

Follow-up authorization risk M1 remains intentionally open: notification credential authorization currently has no dedicated `NOTIFICATION_SEND` capability. Adding that capability is a separate product authorization decision and was not included in the P1-04 lifecycle correction.

## P1-05 Telegram Polling Durability State

Telegram polling now resumes from a PostgreSQL singleton cursor and deduplicates through a content-free update ledger. Every non-empty batch is validated as a whole, duplicate ids collapse to their first occurrence, and updates are processed sequentially in ascending order. Claim precedes the handler; terminal status and cursor advance commit atomically afterward. SQL prevents the cursor from passing a lower `PROCESSING` row, attempts are bounded, terminal rows prune at most hourly, and empty polls write nothing.

Malformed batches create no claims or completions and leave the cursor unchanged. After the configured consecutive threshold, Telegram polling halts with runtime health inactive while the HTTP tier remains available. Recovery is the service-role RPC `force_advance_telegram_offset`, which accepts only a forward move from an active SYSTEM_ADMIN and writes one audit row. Processing is at-least-once: a crash during a handler or before atomic completion can repeat one update's external side effects.

One additive migration, `202609120001_create_telegram_polling_state.sql`, brings the repository total to 18 and preserves all 17 historical hashes. Fresh disposable PostgreSQL applied 18/18 migrations and passed all 11 polling database tests. The full active suite passed 755 tests with 52 opt-in database tests skipped.

## P1-06 Telegram Fan-Out Pacing State

All production notification sends now share one dependency-free in-process fan-out gate. The small-VPS defaults allow at most three active Telegram sends and space request starts by at least 100 milliseconds. Direct and persisted notification intake use fixed worker slots rather than recipient-wide promises; persisted delivery and reminder paths retain their existing sequential accounting while passing through the same global gate.

Shutdown aborts queued pacing waits and prevents additional sends from starting. Each recipient outcome remains isolated and input-ordered, and the coordinator never retries: timeout, bounded retry, and Telegram 429 handling remain owned by the unchanged P1-02 client. P1-06 added no migration or dependency. Focused notification, delivery, Telegram HTTP, and configuration coverage passed 126 tests; the full suite passed 771 tests with 52 opt-in database tests skipped.

## P1-07 Readiness State

`GET /health` remains rate-limit-exempt, database-independent liveness. `GET /ready` is also exempt and returns only the approved sanitized contract with `Cache-Control: no-store`; it fails with 503 on database, required-schema, admin-session wiring, or persisted-notification-intake failure. Its single `load_telegram_polling_state` RPC is abortable, has a 2000 ms default timeout, does not retry, and uses a 1000 ms single-flight cache without stale-while-error. Enabled but inactive Telegram polling, reminder scheduling, and alert evaluation produce non-gating warnings only. Deployment, rollback, generic VPS runtime validation, and the browser System view now use real readiness while retaining `/health` for liveness. Focused validation passed 102 tests; the full suite passed 801 tests with 52 opt-in database tests skipped.

## P1-08 Correlation State

Notification intake now emits a structured chain from Fastify `request_id` to external/generated `event_id`, persisted `notification_event_id`, intent `notification_id`, delivery `delivery_id`, and Telegram send outcome. The existing notification-event foreign key is selected for background delivery retries, so event tracing survives beyond the original request without a migration. Correlation fields are carried through the existing delivery adapter and P1-06 fan-out while P1-02 retains transport retry ownership; no request body, message, token, credential, or secret is logged. Focused correlation/regression coverage passed 99 tests and the full suite passed 805 tests with 52 opt-in database tests skipped.

## Runnable UI Demo State

The Fastify-served vanilla browser UI is now a responsive Tabler Free-based Sotoayam operational dashboard rather than the earlier user-only screen. Only compiled Tabler CSS and the locally used SVG icons are vendored under `public/vendor`; there is no CDN or frontend framework/toolchain in the application. It logs in through P1-01 sessions, sends the CSRF cookie on mutations, handles logout and expired sessions, and never reads or stores shared, service-role, or integration secrets. Dashboard, task, integration, credential-metadata, notification-activity, system-health, and available alert views consume existing APIs only; unavailable metrics render a neutral state. Eight focused UI tests and the 779-test repository suite pass, with 52 opt-in database tests skipped. This is a demo milestone, not completion of the broader Phase 2 settings work or Phase 3 operational UI backlog.

## P2-00 SYSTEM_ADMIN Invariant State

SYSTEM_ADMIN grant/revoke routes now accept only session principals that resolve to a currently effective SYSTEM_ADMIN; the shared administrator key cannot perform these mutations. Audit attribution passes the real actor user into the database RPC. Effective authority means an unrevoked assignment held by an active user in an active authority-capable division.

Migration `202609130001_harden_effective_system_admin_invariant.sql` brings the repository total to 19 without changing the previous 18 migrations. It reuses `gwens_system_admin_invariant`, locks and counts effective administrators in the mutation transaction, and protects authority revoke, user deactivate/move, division deactivate, and authority-capability disable. The legacy user access route now uses the same session actor and guarded service instead of falling back to a direct update. Clean disposable PostgreSQL applied 19/19 migrations twice and passed first-admin bootstrap plus serialized invariant scenarios.

## P2-09 Admin & User Management Design State

P2-09 is implemented from `docs/adr/P2-09-admin-user-management.md`. The session-only effective-SYSTEM_ADMIN surface now provides bounded user search/detail, atomic administrator and login-credential creation, profile/access/authority operations, exact safe DTOs, keyset pagination, one-time temporary passwords, and a server-enforced `password_change_required` gate. The Indonesian `Pengguna` dashboard lives in its own ES module and uses only local Tabler assets.

Migration `202609140001_create_admin_user_management.sql` brings the repository total to 20 while the prior 19 hashes remain unchanged. Clean disposable PostgreSQL applied 20/20 migrations twice and passed schema/RLS/RPC, bootstrap, P2-00 sequential/concurrent invariant, session revocation, credential, audit-attribution, and P2-09 atomicity checks. U-01 through U-19 pass; the full suite passes 846 tests with 52 environment-gated database tests skipped.

This milestone ID is deliberately non-conflicting. P2-01 remains runtime settings and OWNER actor redesign exactly as previously recorded.

## P2-01 Runtime Settings and OWNER Actor State

P2-01 is implemented from `docs/adr/P2-01-runtime-settings-owner-actors.md`. Only business timezone, reminder scheduler cadence, and critical-alert policy are persisted in `instance_settings`; a process-local typed provider hot-reloads reporting, alert evaluation/status, scheduler cadence, and notification scheduler status. Deployment/security/worker/Telegram/readiness/logging controls remain environment-only and absent from the API DTO.

OWNER is permission-based and independent of SYSTEM_ADMIN. Report and alert HTTP requests now resolve the exact session user, while shared-key GET compatibility fails closed through the eligible `business_actor_user_id`; shared keys cannot use settings or OWNER mutations. Migration `202609150001_create_runtime_settings_owner_actors.sql` brings the repository total to 21, adds `threshold.manage` to OWNER, service-role RPCs, optimistic versioning, USER-attributed audit, deny-all RLS, and serialized designated-actor protection. Historical migrations #1-20 remain hash-identical.

Focused P2-01 coverage passes 28/28 unit/integration tests, including real `SETTINGS_UNCHANGED` rollback proof and upgrade backfill scenarios for zero, one, and multiple OWNER users. Clean disposable PostgreSQL applies 21/21 twice, and the complete suite passes 886 tests with 52 environment-gated legacy database tests skipped; the P2-01 disposable database suite runs unconditionally.

## P2-02 Message/String Catalog State

P2-02 is implemented from `docs/adr/P2-02-message-string-catalog.md`. Server copy is split into typed domain modules behind `src/messages/catalog.ts`; browser-owned state copy and deterministic formatters live in `public/messages.js`. Common messages, reminder output, the Task/IT/OWNER Telegram consoles, registration outcomes, and the bounded dashboard surfaces now consume those catalogs without changing their exact output or runtime contracts.

`npm run check:message-catalog` enforces a deliberately bounded inventory of 12 catalog-owned literals across nine production call sites. Focused output/reliability regressions pass 245/245, the complete suite passes 896 tests with 52 environment-gated legacy database tests skipped, and clean disposable PostgreSQL applies all 21 migrations twice. P2-02 adds no migration, dependency, API, persistence, or runtime customization.

## MVP Closure Checkpoint

The authenticated development-instance smoke test passed login, user management, task create/read/edit, `OPEN` to `IN_PROGRESS`, administrative cancellation, runtime settings, one real Telegram test delivery, logout/login, `/health`, and `/ready`. The notification proof was exactly one event, one intent, one delivered delivery, and one Telegram attempt. The dashboard now exposes existing task creation/status/cancellation contracts and a session-only effective-SYSTEM_ADMIN test-notification flow; it does not bypass canonical task or notification services.

Migration #23 grants the generic OWNER role the existing MVP task bundle without coupling OWNER to SYSTEM_ADMIN. Administrative cancellation remains a separate verified effective-SYSTEM_ADMIN exception and does not grant generic edit-all authority. The development instance designates its own OWNER + SYSTEM_ADMIN business actor; no named development identity is a product default.

P2-03 is complete after approved Phase B cutover. `NORMALIZED` is authoritative for the seven existing preferences, while atomic mirrored legacy columns and `LEGACY` resolver mode remain the rollback path.

## Next Agent
Recommended: define the existing P3-05 pagination/loading/basic-responsive-layout scope against the current dashboard before implementation.

## Pending Higher-Level Work
- Continue with the ordered Phase 3 scope while preserving the P1 security/reliability boundaries and the P2-00 effective-administrator invariant.
- P2-09 and P2-01 are complete; preserve their independent SYSTEM_ADMIN and OWNER authorization contracts.
- Preserve remaining launch gates: Phase 4 clean-room install, upgrade/rollback, restore drill, and final security review are still separate pre-customer requirements.

## P3-01 Fresh Install and First OWNER Bootstrap

P3-01 adds migration `202609250001_create_first_owner_web_bootstrap.sql`, bringing the repository total to 24 while migrations #1-23 remain hash-identical. The customer path is now `/setup`: it collects owner name/email/password, first Divisi, and timezone without exposing an administrator key. Sessionless double-submit CSRF, SameSite cookies, the login-rate policy, strict payload validation, and the database's permanent bootstrap eligibility gate protect the public flow.

`provision_first_owner` composes the existing fresh-install transaction with OWNER assignment, explicit SYSTEM_ADMIN assignment, runtime settings, and business-actor designation under the existing advisory locks. `password_change_required=false` is intentional so the first OWNER can log in immediately. Failed late-stage settings validation proved full rollback; simultaneous disposable-PostgreSQL attempts produced exactly one complete owner. Clean migrations apply 24/24 twice with schema/RLS/RPC/bootstrap/invariant checks passing. No Kento, development email, Telegram identity, or dummy customer data is created by migrations or product bootstrap.

## P3-03 Backup / Restore + Customer Recovery State

P3-03 provides manual operator commands `backup:create`, `backup:verify`, and `backup:restore`. The V1 artifact is a custom-format PostgreSQL public-schema data archive paired with a non-secret V1 manifest and SHA-256 checksum. Direct and same-project Session Pooler connections are accepted only with an explicit 20-character Supabase project ref, port 5432, and `sslmode=require`; transaction pooler and ambiguous identities are rejected.

Restore is limited to an explicitly marked clean recovery target whose migration registry exactly matches all 25 repository migrations. It keeps triggers and foreign keys active, restores all public application tables in one transaction, clears ephemeral sessions/login attempts/pairing tokens, reconstructs the seven normalized Telegram preferences through the P2-03 trigger, and validates OWNER, effective SYSTEM_ADMIN, business actor, bootstrap/credential, Telegram mapping, settings, and readiness-schema invariants. Disposable PostgreSQL proof covers successful recovery, checksum/format rejection, target/confirmation guards, and `/setup` replay refusal. Environment secrets remain outside the database archive and must be recovered separately.

Final review moved all hard post-restore invariants inside the restore transaction before commit, expanded the clean-target gate to every non-seed operational table, verified the recovered password hash with the original fixture password, and proved an invalid archive rolls back without emitting restore success. Focused recovery coverage passes 8/8; the complete suite passes 987 tests with 52 environment-gated database tests skipped, and clean migration verification applies 25/25 twice.

## P3-04 Packaging + Production Deployment State

P3-04 defines the supported V1 production topology as one Linux VPS running the exact pinned Node.js LTS patch under a non-root systemd service, with Nginx terminating HTTPS and proxying only to the localhost Sotoayam port. Production startup now fails closed for non-loopback binding, insecure session cookies, or disabled proxy trust. Runtime secrets live only in the protected systemd environment file; deploy-only Supabase credentials are rejected there and remain temporary operator inputs for the explicit pre-activation migration step.

The release archive is built only from a clean committed worktree, carries compiled server/migration code, public assets, migrations, operator documentation/templates, and non-secret Git/Node version metadata, and excludes `.env`, local Supabase state, dependencies, tests, logs, backups, and internal engineering documents. Packaging uses a partial filename and atomically publishes the final archive only after success. The environment installer refuses silent replacement, cleans failed `.env.next` files, and requires explicit `--replace` for a reviewed update.

Final review found and closed the silent environment-overwrite and misleading partial/dirty-archive risks. Production-like smoke proves built-code startup, `/health`, `/ready`, static UI, fresh `/setup`, SIGTERM shutdown, and no watcher. The full suite passes 998 tests with 52 environment-gated tests skipped; contract, secret, governance, catalog, dependency-audit, and clean-migration gates pass, with all 25 migrations applying twice unchanged.

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
