# Sotoayam Database Backup and Recovery

This runbook covers a logical backup of the Sotoayam application schema and a restore drill in an isolated PostgreSQL target. It never authorizes restoring into production.

## Scope and safety

- Back up the `public` schema and its data. This contains the Sotoayam application tables, functions, constraints, indexes, RLS state, policies, and business rows.
- Validate the Supabase migration registry separately. Migration history and Supabase-managed platform schemas are not application data in this logical artifact.
- Do not blindly dump `auth`, `storage`, `realtime`, `extensions`, `supabase_migrations`, or other platform-owned schemas. Supabase manages those objects.
- A logical backup does not include Telegram message history, environment variables, credentials, VPS files, journald, unfinished in-memory wizard state, or external-service state.
- Never print or persist a database password, connection URI, service key, or CLI-generated temporary login. Never place a dump in Git, a release archive, or the VPS application directory.
- Prove the recovery target is isolated and non-production before any `pg_restore` or `psql` restore command.

## Required tools

- An authenticated Supabase CLI linked to the correct project.
- `pg_dump`, `pg_restore`, `psql`, `initdb`, `pg_ctl`, and `createdb` with a major version equal to or newer than production PostgreSQL.
- A protected operator-local backup directory outside the repository and VPS.
- SHA-256 tooling such as `Get-FileHash` on Windows.

PostgreSQL 17.11 client tools were used for the verified 2026-09-02 drill against production PostgreSQL 17.6. An older major-version `pg_dump` must not be forced against a newer server.

## Create a manual logical backup

Preferred supported approaches are:

1. Use `supabase db dump --linked` with its supported runtime to create separate schema and data dumps for `public`; or
2. use PostgreSQL `pg_dump` with an already-authorized, non-interactively supplied database connection. Do not place the connection URI or password on the command line.

For a single custom-format application artifact, the effective `pg_dump` contract is:

```text
pg_dump --format=custom --schema=public --no-owner --no-acl --role=postgres --file=<protected-path>.dump
```

The verified drill used a short-lived login issued by authenticated linked Supabase tooling. Connection fields existed only in a restricted temporary file, were supplied through process environment variables, and were deleted immediately after the dump.

After creation:

1. Run `pg_restore --list <backup.dump>` and require exit code zero.
2. Record the UTC creation timestamp, byte size, and SHA-256 checksum.
3. Move the artifact to a protected operator-local directory outside Git and outside the VPS.
4. Restrict filesystem ACLs to the designated operator account.
5. Store the checksum next to the backup without any credential data.

## Create an isolated recovery target

Use a disposable PostgreSQL cluster or separately provisioned non-production Supabase project. For a local PostgreSQL drill:

1. Select an unused non-production port and a new temporary data directory.
2. Initialize a new cluster and bind it to loopback only.
3. Create a database named clearly for recovery, such as `sotoayam_recovery`.
4. Verify the database name, loopback server address, port, server version, and temporary data directory.
5. Confirm the target is not the production host or project.

Required pre-restore assertion:

```text
RECOVERY_TARGET_IS_PRODUCTION = false
```

Local `trust` authentication is acceptable only for a short-lived loopback-only cluster in a protected temporary directory. Stop and remove that cluster immediately after validation.

## Restore procedure

The target database must be empty and disposable. Dropping its default `public` schema is permitted only after the non-production proof.

```text
psql <recovery-target> --set ON_ERROR_STOP=1 --command "drop schema public cascade;"
pg_restore --exit-on-error --no-owner --no-acl --dbname=<recovery-target> <backup.dump>
```

Require `pg_restore` exit code zero. Do not ignore constraint, schema, data, or ownership errors merely to complete a drill. Platform-owned schemas are intentionally outside this artifact, so their absence is not a restore warning.

## Post-restore validation

Verify only aggregate/status information; do not dump personal rows.

- All expected Sotoayam tables, functions, indexes, and constraints exist.
- RLS remains enabled on every protected application table.
- No unintended policy grants public access.
- Production and recovery counts match for users, tasks, alerts, notifications, integration identities, and collaboration rules.
- Normalized/legacy identity reconciliation has no missing, mismatched, or duplicate identity.
- Foreign-reference orphan checks return zero.
- The reporting classification index and alert/notification dedupe indexes exist.
- Application typecheck/schema contracts pass.
- A temporary application configuration can start and answer health with `TELEGRAM_POLLING_ENABLED=false`, `REMINDER_SCHEDULER_ENABLED=false`, and `CRITICAL_ALERT_EVALUATOR_ENABLED=false`.

The application uses Supabase PostgREST, so a raw PostgreSQL target does not provide a Supabase HTTP API. Validate restored domain state directly with read-only SQL unless the recovery target is a full isolated Supabase environment. Never point the production Telegram bot at a recovery target.

## Verified recovery point

The 2026-09-02 drill produced and restored this application logical backup:

- Filename: `gwens-production-public-20260902T093513Z.dump` (historical artifact name retained so operators can identify the verified backup)
- Size: `151130` bytes
- SHA-256: `37071c90278fc954e372d20d2626b5d48b37296cdec102dee7bfeb052469d2b1`
- Contents: `public` schema and data, custom format, 276 archive TOC entries
- Recovery target: disposable loopback-only PostgreSQL 17.11 cluster
- Restore: exit code zero with empty stderr
- Integrity: 22/22 application tables, 22 RLS-enabled tables, zero public policies, identity `MATCH=5`, zero missing/duplicate links, and matching production/recovery domain counts

The verified artifact is retained in a restricted operator-local backup directory outside the repository and VPS. Supabase Dashboard backup inventory remained empty and PITR remained disabled at verification time; the retained logical artifact is therefore the current recovery point.

## Controlled-beta policy

- Create a manual logical backup before every major deployment or migration.
- While Dashboard backup/PITR is unavailable, create a logical backup at least daily.
- Retain at least seven daily recovery points and the latest pre-migration point, subject to approved data-retention policy.
- Keep backups outside Git and outside the VPS, with restricted ACLs and a second approved durable location when available.
- Calculate and verify SHA-256 for every artifact.
- Run a restore drill at least monthly and before any high-risk migration; record the result without personal data.
- Periodically test that the documented restore steps still work with the current production PostgreSQL major version.

Daily automation may be proposed separately after a secure credential source, encrypted storage destination, retention job, monitoring, and failure ownership are approved. Do not embed database credentials in Task Scheduler, scripts, repository files, or command history merely to automate this policy.

## Cleanup

After a successful drill:

1. Stop the temporary PostgreSQL server.
2. Remove its data directory, extracted temporary tools, CLI login artifacts, restore logs, and plaintext connection artifacts.
3. Retain only the verified backup and checksum in the protected backup directory.
4. Confirm the repository is clean, laptop Sotoayam polling remains off, and production runtime was never used as the restore target.
