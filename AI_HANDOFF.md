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

## Migration State
One official ordered migration command exists: `npm run migrate`. It validates the repository migration inventory, then uses the established Supabase CLI migration registry to apply pending migrations in deterministic filename order.

`npm run migrate` is the required migration entry point. The next migration/deployment task is P0-08: wire migrations into deployment before release activation.

## Next Agent
Recommended: Codex.

Next task:
P0-08 wire migrations into deployment before release activation.

Reason:
The ordered migration command is implemented and tested; deployment must invoke it safely before activating a release.

## Pending Higher-Level Work
After the immediate patch:
- idempotent notification intake;
- parameterized install;
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
