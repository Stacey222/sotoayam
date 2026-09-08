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

## Migration State
One official ordered migration command exists: `npm run migrate`. It validates the repository migration inventory, then uses the established Supabase CLI migration registry to apply pending migrations in deterministic filename order.

`npm run migrate` is the required migration entry point and is now a mandatory pre-activation gate in `scripts/deploy/deploy-release.sh`. Migration failure prevents the release symlink from changing or the service from restarting. Deployment installs the pinned CLI only in the inactive release, establishes link state from protected deploy-only environment variables, then removes CLI link state and development tooling before activation.

Application rollback and database migration rollback are distinct. The existing application rollback can atomically select the previous compatible release; database migrations remain forward-only and are never reversed automatically.

Fresh-install deployment identity and paths are parameterized through the shared `scripts/deploy/deployment-config.sh` contract. `DEPLOY_USER` is explicit; fresh defaults use `/opt/sotoayam`, the `sotoayam` service account/group, and `sotoayam.service`. Existing installations can continue supplying compatibility-sensitive legacy identifiers without renaming active resources.

`.node-version` is the authoritative deployment runtime pin. Bootstrap installs the exact supported Node.js version and release deployment rejects any different runtime before dependency installation or activation.

Fresh-customer installation defaults are separated from the historical staged cutover. Fresh runtime validation now checks configuration shape, the exact Node.js pin, and generic localhost health without requiring origin-company users, Divisi, roles, collaboration rules, or row counts. Historical business-data validation remains available only through an explicitly legacy, opt-in checker that is excluded from fresh release archives.

Operational worker flags remain explicit customer choices: safe preparation values do not silently enable Telegram polling, reminders, or critical-alert evaluation, and fresh installation no longer forces the original all-disabled cutover state. The fresh host and business-timezone fallbacks are `127.0.0.1` and `UTC`; existing installations retain compatibility through explicit environment values.

Historical operational assumptions are not universal product requirements. Remaining customer taxonomy hardcoding is deferred to P0-13/P0-14, and broader private operational documentation cleanup remains P0-15.

## Next Agent
Recommended: Claude Code.

Next task:
P0-11 design the first-admin bootstrap flow.

Reason:
P0-05 and P0-06 are complete. The orchestrator roadmap places P0-11/P0-12 next, beginning with the approved design step.

## Pending Higher-Level Work
After P0-10:
- first-admin bootstrap;
- taxonomy-as-data;
- install documentation.

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
