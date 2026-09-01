# Gwens Automation Control — Codex Project Protocol

These instructions apply to the entire repository. They are the permanent engineering baseline for future work; each future Slice prompt is a delta that adds to or explicitly overrides this protocol for that task.

## Scope and Operating Discipline

- Inspect the actual repository, Git state, migrations, scripts, tests, and runtime configuration before acting. Do not rely only on a prompt's summary.
- Preserve legitimate user changes. Never discard, overwrite, or reformat unrelated work to obtain a clean diff.
- Implement only the requested Slice or fix. Do not start a later Slice or add adjacent product features without explicit authorization.
- Make the smallest coherent change that satisfies the requested contract and existing architecture.
- Run the applicable standard gates automatically, investigate failures to root cause, and report evidence rather than assumptions.
- A deployment is authorized only when the current request includes deployment or live acceptance. Deploy only a committed and verified `HEAD`.

## Permanent Terminology and Architecture

- Use **Divisi** in business and user-facing language.
- Use `division` in code, database schemas, APIs, and internal contracts.
- Never introduce or use `department` as a synonym.
- Telegram is an interface and transport layer, not a second business-logic engine.
- `TaskService` and the canonical domain services are authoritative for validation, authorization, ownership, lifecycle, audit, and persistence.
- Cross-Divisi access is default-deny. Allow it only through an explicit, tested business rule.
- `SYSTEM_ADMIN` grants system administration authority; it does not automatically bypass business task permissions.
- Human identity and machine/integration identity must remain separate.
- Never create fake human users to represent schedulers, importers, bots, or other machine integrations.
- Keep compatibility projections, such as legacy Telegram records, reconciled through the existing canonical transactional service paths. Do not update canonical and compatibility tables independently.

## Security and Production-Data Safety

- Never print, commit, document, or expose secrets, `.env` values, authorization headers, API/service keys, Telegram credentials, SSH private keys, or Telegram external IDs.
- Read secrets from approved environment/configuration paths and keep diagnostics sanitized.
- Derive authorization context, actor identity, `created_by`, and requesting Divisi server-side. Do not trust user-controlled payloads for authority.
- Preserve RLS. Do not disable RLS, weaken policies, or add public policies without an explicitly approved architecture change.
- Never delete, truncate, rewrite, or fabricate legitimate production data merely to make a checker or test pass.
- Production diagnostics must be non-destructive, narrowly scoped, repeatable, and clean up only their own uniquely marked temporary records.
- Do not modify Hermes integration or behavior unless the current request explicitly requires it.

## Laptop and VPS Runtime Separation

### Laptop

- The laptop is for development and verification only; it is not a production runtime.
- `LOCAL_GWENS_POLLING=OFF` is the default and required steady state.
- Production schedulers are disabled by default.
- Do not leave a local bot poller, production scheduler, or duplicate long-running Gwens process active after verification.

### VPS

- The VPS is the sole Gwens production runtime.
- Gwens is managed by systemd and runs under its designated non-root service account.
- `VPS_GWENS_POLLING=ON` is required for the production Telegram poller.
- Production schedulers run only on the VPS and only when their Slice has passed staged cutover and acceptance.
- Bind the application to localhost unless an explicitly approved architecture requires external binding.
- Prevent duplicate Telegram polling before and after every cutover; exactly one production poller may be active.

## Baseline and Change Preparation

Before implementation:

1. Record branch, `HEAD`, concise status, and recent commits.
2. Identify dirty or untracked files and preserve their ownership.
3. Inspect relevant services, migrations, tests, checkers, configuration, and deployment scripts.
4. Verify local and live migration history when the work touches the database.
5. Stop and report any unexplained schema, migration, identity, or runtime divergence before making a dependent change.

## Implementation and Debugging

- Follow existing conventions and extend canonical services rather than duplicating business rules in Telegram handlers, scripts, or integrations.
- Keep authorization and lifecycle transitions transactional where the existing architecture requires atomic reconciliation and audit.
- Treat a failing checker as a debugging signal, not a request to manipulate production state.
- Determine whether failure comes from application code, schema, migration history, configuration, stale checker assumptions, or genuine data inconsistency.
- Fix the cause or the invalid checker assumption, then add or update regression coverage where appropriate.
- Do not weaken assertions solely to turn a failure green.

## Database and Migration Rules

- Prefer additive, forward-only migrations that are safe for existing production rows.
- Never edit an already-applied migration or repair migration history without explicit approval and verified evidence.
- Use the repository's established migration naming and contract conventions.
- Preserve RLS and least privilege for every new table, function, view, or policy.
- Validate local migration files against the live migration registry before deployment and again after applying migrations.
- Do not perform automatic database rollback. If a release rollback is required, assess schema compatibility explicitly and use a reviewed forward repair when necessary.

## Required Quality Gates

For code, schema, or runtime changes, run all applicable gates before declaring completion:

- `npm run typecheck`
- `npm run build`
- the full automated suite with `npm test`
- focused tests for the changed behavior
- `npm run test:contract`
- all applicable schema and architecture checks exposed by the repository's `check:*` scripts
- identity/legacy reconciliation checks when identity paths are affected
- Supabase diagnostics when Supabase configuration, schema, RLS, or live data paths are affected
- `npm run check:secrets`
- migration baseline verification against the clean committed checkpoint

At minimum, preserve coverage for schema contracts, migration baseline, Supabase connectivity and server writes, reconciliation, secret scanning, permissions, and the affected service contracts. Discover the current scripts from `package.json`; do not assume this list replaces newer project gates.

Record actual pass/fail results and test counts. If any required gate cannot run, state the exact blocker and do not represent the Slice as fully verified.

## Git Discipline

- Keep commits focused on the requested task and review the final diff before committing.
- Never commit secrets, generated secret-bearing artifacts, temporary SSH keys, deployment archives, logs, or unrelated user work.
- Run diff whitespace validation and secret scanning before the final commit.
- Finish with a clean working tree unless the remaining changes were explicitly identified as pre-existing user work.
- Production deployment must reference the exact committed `HEAD`; never deploy uncommitted local files.

## Versioned VPS Deployment

When deployment is in scope:

1. Re-run the required local gates and commit the verified change.
2. Build a versioned release identified by the Git SHA; do not mutate the active release in place.
3. Transfer only the required release artifact without `.env`, credentials, local caches, or development-only files.
4. Install/build in the versioned release directory, preserving the VPS-owned environment outside the release.
5. Apply only verified pending migrations.
6. Stop the service for the shortest practical cutover window, atomically repoint `current`, and start the systemd service.
7. Verify the active release SHA, systemd enabled/active state, bounded recent logs, localhost health, polling state, scheduler state, and absence of duplicate processes.
8. Keep the previous compatible release available for application rollback and document the rollback command/path before acceptance.
9. Remove temporary SSH private/public keys, authorized-key entries, archives, and local/remote staging artifacts after verification. Report what was removed.

Never print secrets or authorization material while deploying or diagnosing.

## Live Acceptance

- Separate implementation completion, automated verification, deployment completion, and live acceptance in status reports.
- Exercise the real production entry point for the changed behavior using only safe, authorized test data.
- Verify authoritative database state and audit/reconciliation effects without dumping production rows or external identifiers.
- Clean up only test records created by the acceptance procedure when cleanup is safe and contractually expected.
- Recheck systemd health, bounded logs, polling uniqueness, and scheduler ownership after acceptance.

## Final Report

Every completed task must concisely report:

- completed work;
- blockers or problems;
- risks and operational information;
- tests and gate results, including counts where available;
- Git branch, commit SHA, and working-tree status;
- migration state when relevant;
- deployment and runtime state, including local/VPS polling and scheduler state when relevant;
- rollback readiness when deployed;
- cleanup status for temporary credentials and artifacts; and
- exactly one recommended next step.

Future Slice prompts may therefore be short: state the Slice objective, delta requirements, acceptance criteria, and whether migration/deployment/live acceptance is authorized. This protocol supplies the unchanged engineering, safety, verification, Git, and runtime baseline.
