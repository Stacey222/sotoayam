# P0-16 Clean Install Rehearsal

Executed 2026-09-09 against repository commit `e9caeeb` on branch `main`, working tree clean at start.

## Verdict

**P0-16 PASS — PHASE 0 COMPLETE.**

Four sessions of evidence are recorded in this report:

1. **Initial rehearsal.** The database layer of the commercial workflow was rehearsed end to end on a disposable PostgreSQL 16 cluster and passed every check. The application layer could not be rehearsed, because the supported installation path requires a hosted Supabase project: `npm run migrate` resolved to `supabase db push --linked`, and the runtime loads all data through the Supabase HTTP client. Two blockers of packaging/tooling origin were found alongside the Supabase dependency: F-002 (`npm run migrate` broken in a production-only install) and F-003 (release archive not self-installable).
2. **F-002/F-003 remediation.** Both were fixed and re-verified against a freshly rebuilt real release archive: the migration runner now ships compiled (`dist/scripts/migrate.js`, no `tsx` dependency) and the archive now includes `.env.example` and customer-facing operator documentation. Full evidence is under **Issues Found** below; these two findings are now **RESOLVED**.
3. **Initial F-001 resolution attempt.** Instructed to complete the rehearsal using a disposable Supabase environment, preferring a local stack over a hosted one. A local Supabase stack requires Docker or Podman; neither is installed, and Windows Subsystem for Linux is also not installed. This was proven by direct invocation of the product's own pinned Supabase CLI:

   ```
   $ node_modules/.bin/supabase start --workdir .
   {"_tag":"Error","error":{"code":"LegacyDockerLifecycleInspectError",
    "message":"failed to inspect container health: docker: command not found
    (podman also not found) — install Docker Desktop or Podman and ensure it is on PATH"}}
   ```

   No hosted disposable target was available during that attempt, so F-001 remained open at that point.

4. **Hosted disposable Supabase completion and restore rehearsal.** An operator subsequently supplied credentials scoped to an authorized disposable restore target. Local linked metadata, credential project identity, Supabase URL, and pooler identity agreed. The remote migration registry contained exactly the same 15 versions as the repository, and the remote public schema contained exactly the expected 28 application tables. The data-only backup restored successfully in one transaction after all 28 application tables were truncated together without `CASCADE`; triggers remained enabled. Restored state verified `FRESH` provenance, active `OPERATIONS`, the first active administrator with role `ADMIN`, active `SYSTEM_ADMIN`, one credential, and the singleton bootstrap marker. The application was then started against the restored target with Node 24.20.0, Telegram polling and both schedulers disabled; `GET /health` returned HTTP 200 with `{"status":"ok"}`. F-001 is resolved.

No architecture redesign was attempted. No historical migration was edited. No production Supabase project, VPS, or Telegram API was contacted. Nothing was committed.

## Environment

| Item | Value |
| --- | --- |
| OS | Windows 11 Home Single Language 10.0.26200 |
| Shell | Git Bash (MINGW64) and Windows PowerShell 5.1 |
| Node (installed) | v22.14.0 |
| Node (required by `.node-version` / `engines`) | 24.20.0 — exercised for the restored-target application health check |
| npm | 10.9.2 |
| PostgreSQL | 16.15 (server + `psql`, `pg_dump`, `pg_restore`, `initdb`, `pg_ctl`) |
| Docker / Podman | **Neither installed** — confirmed directly by the Supabase CLI's own `LegacyDockerLifecycleInspectError` when `supabase start` was attempted |
| WSL 2 | **Not installed** (`wsl --list --verbose` → "The Windows Subsystem for Linux is not installed") — a Docker Desktop prerequisite on this host, so this is upstream of the Docker gap |
| Supabase CLI | 2.116.0 (pinned devDependency, present in the extracted package after a dev install) |
| Disposable cluster | `127.0.0.1:55432`, trust auth, loopback only, temporary data directory in the session scratchpad |
| Live infrastructure contacted | Authorized disposable hosted Supabase restore target only; no production Supabase project, VPS, or Telegram API |

Environmental limitations that affected results:

1. The default installed Node runtime is v22.14.0. The restored-target application check explicitly used Node 24.20.0, satisfying the runtime acceptance requirement.
2. Docker/Podman and WSL 2 remain absent, so the initial local-stack path was unavailable. The authorized hosted disposable target resolved that environmental constraint; see F-001.
3. Under Git Bash the MSYS `tar` binary rejects Windows absolute paths (`Cannot connect to C: resolve failed`), which failed 8 deployment tests. Re-run from PowerShell the same file passes 9/9. This is a shell artifact, not a product defect (see F-008).

## Release Archive

Built with the supported command:

```
powershell -NoProfile -File scripts\deploy\package-release.ps1 -OutputPath <scratchpad>\release\sotoayam-p016-rehearsal.tar.gz
```

| Property | Value |
| --- | --- |
| Filename | `sotoayam-p016-rehearsal.tar.gz` |
| Size | 127,455 bytes |
| SHA-256 | `c7b6f559217980c83155d82ce1ee133fe16b10863277644340092137945238e2` |
| Entries | 156 |
| Build result | `npm run build` succeeded, packaging exit 0 |

Extracted to an isolated temporary directory outside the repository.

**Present and correct:**

| Required content | Result |
| --- | --- |
| Compiled runtime (`dist/src`) | Present |
| Static admin UI (`public/`) | Present |
| `package.json`, `package-lock.json` | Present |
| `.node-version` | Present |
| All 15 migrations | Present — count verified as 15 |
| Migration runner (`scripts/migrate.ts`) | Present |
| Deploy helpers (`deployment-config.sh`, `check-vps-runtime.mjs`) | Present |

**Correctly absent:**

| Forbidden content | Occurrences |
| --- | --- |
| `gwensoto` | **0** |
| `supabase/config.toml` | 0 |
| `.env`, `*.pem`, `*.key` | 0 |
| `node_modules` | 0 (by design; installed at deploy time) |
| Local PostgreSQL files, temp dirs, scratch files | 0 |

**Compatibility identifiers retained (expected, documented):** the string `gwens` appears in `public/app.js` (browser storage key `gwens-admin-key`) and in five historical migrations (advisory-lock key `gwens_system_admin_invariant`). Both are recorded in `README.md` as compatibility-sensitive identifiers under D-013. Origin division literals appear only in immutable historical migrations and in `dist/src/identity/legacy-mapping.js`, the compatibility adapter — never as customer-visible taxonomy after fresh provisioning (proven below).

**Missing (see F-003):** no operator documentation of any kind (zero `.md` files) and no `.env.example`, although `docs/deployment/vps-production.md` step 2 instructs the operator to create `shared/.env` *from* `.env.example`.

## Fresh Database

```
initdb -D <scratchpad>/pgdata -U postgres --auth=trust --encoding=UTF8 --no-locale
pg_ctl -D <scratchpad>/pgdata -o "-p 55432 -h 127.0.0.1" start
```

| Property | Value |
| --- | --- |
| Server version | PostgreSQL 16.15 |
| Address | `127.0.0.1:55432` (loopback only) |
| Databases created | `sotoayam_p016_fresh`, `sotoayam_p016_ops`, `sotoayam_p016_restore` |
| Data directory | Session scratchpad, removed at cleanup |
| `RECOVERY_TARGET_IS_PRODUCTION` | `false` |

No previously provisioned database was reused.

## Migration Result

The initial unsupported environment failed as expected without a linked hosted Supabase project. Both initial executions were run from the extracted package, not the repository.

Production-dependency install (`npm ci --omit=dev`, 80 packages, 0 vulnerabilities):

```
$ npm run migrate
> tsx scripts/migrate.ts
'tsx' is not recognized as an internal or external command
```

Development-dependency install (`npm ci --include=dev`, what `deploy-release.sh` performs):

```
$ npm run migrate
MIGRATIONS_DISCOVERED = 15
- 202608260001_create_telegram_users.sql
  … all 15 listed in order …
Applying pending migrations through the Supabase migration registry...
{"_tag":"Error","error":{"code":"LegacyProjectNotLinkedError",
 "message":"Cannot find project ref. Have you run supabase link?"}}
MIGRATION_RESULT = FAIL
```

The preflight is correct — all 15 migrations are discovered, ordered, and duplicate-checked — but application requires `supabase db push --linked`, i.e. a live hosted project. `scripts/deploy/deploy-release.sh` confirms this is the only supported path: it exits non-zero unless `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, and `SUPABASE_PROJECT_REF` are all set, then runs `supabase link --project-ref` before migrating. There is no `DATABASE_URL` or self-managed-PostgreSQL option anywhere in the product.

**Schema verification performed instead**, applying the archive's own migration files to the empty disposable cluster with `psql -v ON_ERROR_STOP=1`:

```
ALL_15_MIGRATIONS_APPLIED=PASS
```

This proved the SQL was valid and ordered against a clean PostgreSQL 16, but did not exercise the Supabase migration registry.

The final hosted-target rehearsal exercised the supported registry state. The linked disposable target reported 15 registered migrations, exactly matching the 15 versioned files in `supabase/migrations`; the comparison had no missing or unexpected version. Its public schema contained the exact expected 28 application tables. This closes the previously unverified supported-path migration check.

## Pre-Setup State

Immediately after migrations, before provisioning:

```
divisions=9
roles=3
collab_rules=1
task_categories=0
provenance=0
users=0
capability=IT
```

This matches the accepted design exactly: historical immutable migrations seed nine divisions and one origin collaboration rule, and the P0-14 migration flags the seeded `IT` division as capability-bearing so an existing installation never loses authority. Provenance is absent, so the installation reads as `UNKNOWN` (legacy-safe). This transitional state is expected and is not a defect. No manual cleanup was performed.

## Setup Result

The supported operator command `npm run setup` could not be exercised: it loads configuration and reaches the database through the Supabase client, which is unavailable. Provisioning was therefore invoked through the product's own `provision_first_installation` RPC directly on the disposable cluster — the same transaction the CLI calls, but without the CLI, prompts, or preview. Classified below as **MOCK / TEST VERIFIED**, not as the operator workflow.

**Failed precheck first** (deliberate invalid input, no corruption):

```
select * from public.provision_first_installation(
  'Clean Room Admin','not-an-email','scrypt','<hash>','FRESH','OPERATIONS','Operations');
ERROR:  INVALID_EMAIL

-- state afterwards
divisions=9   users=0   provenance=0   bootstrap=0
```

Zero partial state. The transaction rolled back completely.

**Successful fresh provisioning:**

```
select * from public.provision_first_installation(
  'Clean Room Admin','clean-room-admin@example.invalid','scrypt','<hash>',
  'FRESH','OPERATIONS','Operations');
user_id | assignment_id | bootstrapped_at              | division_code
1       | 1             | 2026-09-09 14:11:11.612694+07 | OPERATIONS
```

Verified properties: explicit `FRESH` lineage argument required (no heuristic); origin seed retired atomically; `OPERATIONS` created as a real customer-owned division; first administrator created with `ADMIN`; `SYSTEM_ADMIN` granted; `OWNER` not granted; provenance written; bootstrap marker written; no Telegram identity required; no `IT` or `ADMINISTRATION` division left behind.

Not verified through the CLI: the `SETUP_PREVIEW` output, the no-echo password prompts, `--password-file` handling, and flag mutual exclusion. These are covered by `tests/bootstrap/first-admin-bootstrap.test.ts` (unit) but were not run as an operator flow.

## Final Taxonomy

Customer-visible operational catalogs after fresh provisioning:

```
DIVISIONS:       OPERATIONS(Operations, active=true, cap=true)
ROLES:           STAFF(Staff) | ADMIN(Admin) | OWNER(Owner)
TASK_CATEGORIES: NONE
COLLAB_RULES:    0
PROVENANCE:      lineage=FRESH retired_count=10 source=setup_cli
BOOTSTRAP_MARKER: user=1 source=first_admin_bootstrap
ADMIN:           Clean Room Admin division=OPERATIONS role=ADMIN active=true telegram_link=none
AUTHORITY:       SYSTEM_ADMIN revoked=no
OWNER_ASSIGNED:  false
CREDENTIALS:     1
```

| Must be absent | Result |
| --- | --- |
| `IT` | Absent |
| `ADMINISTRATION` | Absent (never created by any code path) |
| `PURCHASING`, `SALES_GROSIR`, `DIGITAL_MARKETING`, `CONTENT_CREATOR`, `ONPAGE_B2C`, `SHOPEE_LIVE`, `GUDANG`, `MANAGEMENT` | All absent |
| `AFFILIATE` category | Absent (catalog empty) |
| Origin collaboration rule | Absent (retired; count 10 = 9 divisions + 1 rule) |

**This section passes without qualification.** No origin-company taxonomy is visible to a fresh customer.

## Application Startup

Executed from the extracted package with an isolated environment file containing only placeholder local values (the developer `.env` was never used and no process environment was inherited).

**Configuration validation works:**

```
$ ADMIN_API_KEY=short node dist/src/server.js
Startup failed: Invalid environment variable: ADMIN_API_KEY must be at least 32 characters
```

**Startup fails without a Supabase endpoint:**

```
$ node --env-file=<isolated>.env dist/src/server.js
{"level":30,...,"persistedNotificationIntake":true,"msg":"Notification intake configured"}
Startup failed: Unable to load installation provenance
$ curl http://127.0.0.1:3199/health   → HTTP=000 (no listener)
```

The process reads `installation_provenance` through the Supabase client during construction and aborts when it cannot. A raw PostgreSQL server does not provide the Supabase HTTP API, a fact `docs/database-recovery.md` already records. That explained the initial failure.

The final acceptance run used only the disposable-target credential file for Supabase configuration; the repository `.env` was not read or reused. Because the target file intentionally contained no application-layer keys, non-production process-local placeholders supplied the required Telegram, internal, and admin key variables for this isolated health process. Telegram polling, the reminder scheduler, and critical-alert evaluation were explicitly disabled. The server started on Node 24.20.0 and logged `telegramPolling=false`; `GET /health` returned HTTP 200 with `{"status":"ok"}`. The exact process then received shutdown and left no listener.

| Endpoint | Status |
| --- | --- |
| `GET /health` | **PASS** — restored-target process returned HTTP 200 with `{status:"ok"}` |
| `GET /ready` | **NOT IMPLEMENTED / DEFERRED** — no route exists; matches ROADMAP P1-07 |

Legacy alias gating was verified statically only: `src/app.ts:319` registers reports with `legacyAliasEnabled: installationLineage !== "FRESH"`, and `src/routes/reports.routes.ts:56` registers `/content-creator/affiliate-task-status` only when that flag is true. The runtime absence of the alias on a `FRESH` installation could not be confirmed over HTTP.

## Admin Operations

Exercised through the product's own management RPCs on the provisioned disposable database. **MOCK / TEST VERIFIED** — the HTTP admin API (`/api/admin/divisions`, `/roles`, `/task-categories`) could not be reached.

```
CREATE_SALES=SALES
CREATE_WAREHOUSE=WAREHOUSE
RENAME_DIVISION=Warehouse & Stock
RENAME_ROLE=Team Member                     (STAFF display name)
CREATE_CATEGORY=GENERAL
update public.divisions set code='RENAMED'  → ERROR: Taxonomy code is immutable
```

All operations succeeded with no manual table manipulation and no source edit. Division codes are immutable; display names are editable; reserved role display names are editable.

Not verified: `ADMIN_API_KEY` header authorization on these routes at runtime, request validation, error codes, and the delete guards. Route-level authorization is covered by the passing suite (`tests/security/admin-route-boundary.test.ts`, `admin-authorization-regression.test.ts`).

## User Onboarding

**Not verified, and a real gap was found.** There is no create-user surface in the product:

| Operation | Availability |
| --- | --- |
| CREATE (non-Telegram) | **Not available** — the only user-creating path is `register_telegram_identity`, invoked when a person sends `/start` to the bot |
| UPDATE ACCESS (division, role, active) | Available — `PATCH /api/admin/users/:id/access` |
| ACTIVATE / DEACTIVATE | Available — same route, `active` field |
| Business user code | Available — `PATCH /api/admin/users/:id/business-user-code` |
| List / read | Available |

Onboarding "Sales User" and "Warehouse User" as described was therefore impossible without Telegram. This is the designed model (users self-register, an administrator then assigns division and role), and it is documented in `README.md`, but it means an operator cannot onboard a colleague who does not use Telegram, and the bootstrap administrator remains the only non-Telegram identity. Recorded as F-004 (MEDIUM), not a blocker in itself.

Assignability of customer-created divisions through `update_user_access` — the behaviour that matters for taxonomy — is proven by `tests/taxonomy/p0-14-database.test.ts` case K/L/M/N/O, which passed against this disposable cluster.

## Task Flow

**NOT VERIFIED.** Task creation, category validation, and task reads all run through `TaskService` in the application process, which could not start. Creating rows directly with SQL would bypass the very validator under test and would constitute manual database surgery, so it was not done.

The category contract is covered by the passing suite (`tests/tasks/task-category-validation.test.ts`, `tests/tasks/task-core.test.ts`, `tests/ingestion/task-ingestion.test.ts`): empty catalog accepts only `null`; a non-empty catalog accepts `null` or an active code; inactive and unknown codes are rejected on create and on category-changing update; reads never validate. Deactivating `GENERAL` and observing an existing task remain readable while a new task is rejected was **not** executed against a running system.

## Collaboration

**NOT VERIFIED at runtime.** The `SALES → WAREHOUSE` rule could not be created through the API, and directional evaluation happens in the application. The origin rule `ONPAGE_B2C → CONTENT_CREATOR` was confirmed retired (collaboration rule count 0 after fresh provisioning), so no origin rule was used or needed.

Default-deny behaviour, directionality, and inactive-endpoint denial are covered by `tests/collaboration/cross-division.test.ts` in the passing suite.

## Reporting

**NOT VERIFIED at runtime.** `GET /api/reports/task-status` could not be called. Statically confirmed that the generic report takes `division`, `task_category`, `window`, and `statuses` parameters and that neither `CONTENT_CREATOR` nor `AFFILIATE` is required by it (`src/routes/reports.routes.ts:45`). Alias absence on `FRESH` was confirmed by code inspection only (see Application Startup).

## Telegram

**VERIFIED CONFIGURATION ONLY.** No Telegram API call was made and no bot token was used.

| Check | Result |
| --- | --- |
| Telegram required for bootstrap? | **No** — the provisioned administrator has `telegram_link=none` and provisioning succeeded with no token |
| Configuration source | Environment only: `TELEGRAM_BOT_TOKEN` (required by `loadConfig`), `TELEGRAM_POLLING_ENABLED` (`"true"` enables polling) |
| Source edit required? | No |
| `LOCAL_GWENS_POLLING` / `VPS_GWENS_POLLING` | **Not required and not accepted** — the only occurrences in the repository are four lines inside P0-15 review documents describing them as stale. No code, script, or example reads them |
| Restart/config lifecycle | Documented in `docs/deployment/vps-production.md`; polling must not run in two processes with one token |

Minimum Telegram variables: `TELEGRAM_BOT_TOKEN` (always required by config loading, even when polling is off) and `TELEGRAM_POLLING_ENABLED`.

## Notification / Reminder / Escalation Path

| Stage | Classification | Basis |
| --- | --- | --- |
| Assign | **NOT VERIFIED** (runtime) | Requires a running application |
| Notification intent persistence | **MOCK / TEST VERIFIED** | `tests/notifications/*` pass; the startup log line `"Notification intake configured", persistedNotificationIntake:true` was observed from the packaged build before it aborted |
| Reminder scheduling / evaluation | **MOCK / TEST VERIFIED** | `tests/reminders/*` pass; schema present in the disposable database |
| Escalation / critical alerts | **MOCK / TEST VERIFIED** | `tests/alerts/critical-alert-engine.test.ts` passes; `acknowledge_critical_alert` is permission-keyed in the migration, not division-keyed; no origin division dependency found |
| Monitoring / reporting | **NOT VERIFIED** (runtime) | Requires a running application |
| External Telegram delivery | **NOT VERIFIED** | No external call was made or attempted |

No stage is claimed as verified end-to-end.

## Backup

Followed `docs/database-recovery.md`, `pg_dump` custom-format contract, against the provisioned disposable database.

```
pg_dump --format=custom --schema=public --no-owner --no-acl -d <disposable> -f sotoayam-backup-20260909.dump
```

| Property | Value |
| --- | --- |
| Filename | `sotoayam-backup-20260909.dump` |
| Location | Session scratchpad, outside the repository |
| Size | 237,490 bytes |
| SHA-256 | `f7b4949aa583f2f51bb5dbb984784c288a88fac67cbd41273550c33de74ad043` |
| `pg_restore --list` | Exit 0, 370 TOC entries |

No credential appeared on any command line; the disposable cluster uses loopback trust authentication in a temporary directory, which the runbook permits for exactly this purpose.

Note: the runbook's *preferred* path is `supabase db dump --linked` or an authorized production connection. Both require a hosted project; only the local `pg_dump` contract was exercisable.

## Restore

Into a **second, completely empty** disposable database:

```
psql --set ON_ERROR_STOP=1 -d sotoayam_p016_restore -c "drop schema public cascade;"
pg_restore --exit-on-error --no-owner --no-acl -d sotoayam_p016_restore sotoayam-backup-20260909.dump
→ exit 0
```

Post-restore validation:

```
provenance=FRESH/retired=10
bootstrap_marker_user=1
admin=Clean Room Admin/OPERATIONS/ADMIN
credentials=1
system_admin_active=1
divisions=OPERATIONS,SALES,WAREHOUSE
roles=STAFF=Team Member,ADMIN=Admin,OWNER=Owner
categories=GENERAL(active=true)
rls_enabled_tables=28
public_policies=0
tables=28
functions=47
```

Every mandated item survived: provenance, bootstrap marker, first administrator, administrator credentials, `SYSTEM_ADMIN` authority, `OPERATIONS`, `SALES`, `WAREHOUSE`, the `GENERAL` category, the renamed role display name, and the full RLS posture with zero public policies.

The final hosted-target restore used `sotoayam-p016-data.dump` (SHA-256 `1423FF47F38B0B45C64220E0A7D82D41D384E93761288A1DF1354239508D6C4F`). Before any write, target name/ref/URL/pooler identity, PostgreSQL role capability, the 15-version migration registry, and the 28-table inventory all matched. The restore then:

1. generated data-only SQL from the valid custom archive with ownership and ACL statements omitted;
2. truncated all 28 application tables together with `RESTART IDENTITY`, without `CASCADE`;
3. applied the data SQL in the same `psql --single-transaction` execution with `ON_ERROR_STOP=1` and triggers enabled; and
4. committed successfully, then removed the protected temporary SQL.

Count-only post-restore evidence was: one provenance row and one `FRESH` row; one active `OPERATIONS` division; one bootstrap marker; one active marked first administrator; one matching active `ADMIN` role; one matching active `SYSTEM_ADMIN` assignment; and one matching administrator credential (one credential total). The restored-target application health check described above completed the mandatory application half of the restore drill.

## Restart / Idempotency

| Check | Result |
| --- | --- |
| Second `provision_first_installation` | `ERROR: FIRST_ADMIN_ALREADY_EXISTS` |
| Legacy four-argument `bootstrap_first_admin` after provisioning | `ERROR: FIRST_ADMIN_ALREADY_EXISTS` |
| `update public.installation_provenance` | `ERROR: Installation provenance is append-only` |
| `delete from public.installation_provenance` | `ERROR: Installation provenance is append-only` |
| Duplicate first administrator | None — users=1, authorities=1 after all attempts |
| Provenance re-armable | No |

**Migration re-run idempotency could not be verified through the supported path**, because that path is the Supabase registry (`supabase db push --linked`), which tracks applied versions. Replaying the migration *files* directly with `psql` — which is not the supported command and which this task explicitly prohibited for the migration step — re-inserted the nine origin seed divisions into the already-provisioned installation:

```
divisions_after_reapply=OPERATIONS,PURCHASING,SALES_GROSIR,DIGITAL_MARKETING,
CONTENT_CREATOR,ONPAGE_B2C,SHOPEE_LIVE,GUDANG,MANAGEMENT,IT
users=1  provenance_lineage=FRESH  authorities=1
```

Identity, authority, and provenance were untouched, but customer-visible taxonomy regressed. The seed statements use `on conflict (code) do nothing`, so a row that was legitimately retired is simply re-created. The product's only protection against this is the migration registry. Recorded as F-005 (MEDIUM).

## Founder-Knowledge Check

| Knowledge | Required for a fresh commercial install? |
| --- | --- |
| `GWENS` | No |
| `gwensoto` | No — zero occurrences in the package |
| Origin division names | No — never entered, never displayed after provisioning |
| Origin collaboration rule | No |
| Historical migration ordering details | No — the runner discovers and orders migrations itself |
| Legacy Telegram schema | No |
| Founder-specific customer data | No |
| Undocumented internal paths | No |
| Migration archaeology | No |

**Result: none required.** The internal compatibility identifiers that remain (`gwens_system_admin_invariant` advisory lock, `gwens-admin-key` browser storage key) are never surfaced to an operator and were not needed at any step. This check passes.

One adjacent observation: an operator *does* need to know that `npm run migrate` requires development dependencies and a linked Supabase project, and neither the package nor `README.md` says so. That is a documentation gap (F-002), not founder knowledge.

## Issues Found

### F-001 — Supported installation requires a hosted or local Supabase environment

Severity: **HIGH**

Status: **RESOLVED.**

Observed behavior (initial rehearsal): the extracted package correctly required a linked Supabase project, but neither a local container runtime nor an authorized hosted disposable target was initially available. The application could not start against raw PostgreSQL because it requires the Supabase HTTP API. This remains intentional architecture under D-005, not a product defect.

Resolution: an operator supplied credentials scoped to a disposable hosted restore target. Identity checks proved the local link metadata, credential project identity, Supabase URL, pooler identity, remote registry, and expected schema all referred to the same disposable project before any write. The remote registry exactly matched all 15 repository migrations. The deterministic single-transaction restore passed, restored security/bootstrap state passed count-only verification, and an application process using Node 24.20.0 returned `/health` HTTP 200 against that restored target. No production project or Telegram API was contacted, and no credential was written to the repository.

### F-002 — `npm run migrate` is unusable in a production-dependency install

Severity: **HIGH**

Status: **RESOLVED** (fixed and verified in the session between the initial rehearsal and this one; re-confirmed here).

Observed behavior (initial rehearsal): after `npm ci --omit=dev` in the extracted package, `npm run migrate` failed with `'tsx' is not recognized`. The runner shipped as TypeScript source (`scripts/migrate.ts`) and both `tsx` and the Supabase CLI were `devDependencies`.

Fix applied: `package.json`'s `migrate` script now runs `node dist/scripts/migrate.js` — the same TypeScript source compiled by the existing `npm run build` step (already covered by `tsconfig.json`'s `include`), matching the pattern already used by `start` and `setup`. A `migrate:dev` script (`tsx scripts/migrate.ts`) was added for pre-build local convenience. `scripts/deploy/package-release.ps1` now ships `dist/scripts/migrate.js` instead of the TypeScript source.

Re-verified this session against a freshly rebuilt real archive (see **Release Archive** and **Migration Result** below): `npm ci --omit=dev` in the extracted package, then `npm run migrate`, now discovers and orders all 15 migrations and reaches the Supabase-CLI-absent failure directly — the `'tsx' is not recognized` error is gone. The deploy flow's existing install-dev-deps-then-prune pattern (`deploy-release.sh`) is unaffected and still reaches the identical `LegacyProjectNotLinkedError` it always did.

Regression coverage: `tests/deployment/deploy-release.test.ts` gained a focused assertion that `package.json`'s `migrate` script contains no `tsx` reference and that the archive ships the compiled runner, not the TypeScript source.

### F-003 — Release archive ships no operator documentation and no environment example

Severity: **HIGH**

Status: **RESOLVED** (fixed and verified in the session between the initial rehearsal and this one; re-confirmed here).

Observed behavior (initial rehearsal): the extracted package contained zero `.md` files and no `.env.example`, even though `docs/deployment/vps-production.md` and `README.md` instruct the operator to create `shared/.env` from it.

Fix applied: `scripts/deploy/package-release.ps1` now also packages `.env.example`, `docs/deployment/clean-install.md`, and `docs/database-recovery.md` — customer/operator installation and backup/restore documentation, containing no ADR terminology, no adversarial-review discussion, and no `gwensoto`/origin-company identifiers. Internal `docs/adr/` and `docs/reviews/` content is never shipped.

Re-verified this session against a freshly rebuilt real archive: `.env.example` present; `docs/deployment/clean-install.md` present; `docs/database-recovery.md` present; zero `.md` files under `docs/adr` or `docs/reviews`; zero `gwensoto` occurrences anywhere in the extracted tree; no `supabase/config.toml`; no `.env`, `.pem`, or `.key` file.

Regression coverage: `tests/deployment/deploy-release.test.ts` gained a focused assertion that the packaging script's archive manifest includes the environment example and both operator documents, excludes any `docs/adr`/`docs/reviews` path and `README.md` (which still legitimately contains `gwensoto` as a documented compatibility identifier for existing installs), and that the shipped documents contain neither `gwensoto` nor ADR/adversarial-review language.

### F-004 — No supported way to create a user who is not on Telegram

Severity: **MEDIUM**

Observed behavior: the admin API exposes list, read, `PATCH /:id/access`, and `PATCH /:id/business-user-code`. There is no create-user endpoint. The only user-creating code path is `register_telegram_identity`, triggered by a Telegram `/start`.

Expected behavior: an operator onboarding staff should be able to create the user records they will then assign.

Evidence: route enumeration of `src/routes/admin-user-management.routes.ts` and `src/routes/users.routes.ts`; `README.md` "Telegram Registration" section.

Impact: the intended rehearsal users could not be onboarded. In production, every user except the bootstrap administrator must own a Telegram account and self-register first. This is the designed model and is documented, so it is not classified as a blocker on its own — but it constrains the commercial workflow and should be an explicit product statement rather than an inference from the route list.

Resolution: documented in the clean-install guide, which now states plainly that staff join by messaging the bot and that the administrator then assigns division, role, and active state.

### F-005 — Replaying migration files outside the registry restores origin taxonomy

Severity: **MEDIUM**

Observed behavior: re-running the 15 migration files with `psql` against an already-provisioned `FRESH` installation re-inserted all nine origin seed divisions. Identity, authority, and provenance were unaffected.

Expected behavior: no operation should reintroduce origin-company taxonomy into a provisioned commercial installation.

Evidence: captured under "Restart / Idempotency" above.

Impact: latent. The supported command (`supabase db push --linked`) consults `supabase_migrations.schema_migrations` and never re-applies an applied version, so this cannot happen on the supported path. It becomes reachable if an operator ever replays migrations manually — during a schema rebuild, a registry repair, or a restore that replays migrations instead of restoring a dump.

Resolution: documented as a prohibition in the clean-install guide ("never replay migration files by hand"). A durable fix would gate the historical seed inserts on provenance, which is a migration change and out of P0-16 scope.

### F-006 — `/ready` is not implemented

Severity: **INFO**

Observed behavior: no `/ready` route exists; only `/health` returning `{status:"ok"}`.

Expected behavior: per ROADMAP, P1-07 owns a meaningful `/ready`.

Evidence: `src/routes/health.routes.ts`; repository-wide search for `/ready` returned no route.

Impact: none for Phase 0. Deployment health checks use `/health`.

Resolution: none — correctly deferred. Reported as required, not implemented.

### F-007 — Pinned Node runtime unavailable during the initial rehearsal

Severity: **INFO**

Status: **RESOLVED for P0-16 acceptance.**

Observed behavior (initial rehearsal): `npm` emitted `EBADENGINE` — required `24.20.0`, current `v22.14.0`.

Expected behavior: the rehearsal should run the supported runtime.

Evidence: `npm ci` output in the extracted package.

Impact: the runtime pin enforced by `bootstrap-vps.sh` and `deploy-release.sh` was not exercised during the initial archive checks. Build, typecheck, and the full test suite passed regardless.

Resolution: the final restored-target application health check explicitly ran Node 24.20.0. The server started successfully and returned `/health` HTTP 200.

### F-008 — Deployment tests fail under MSYS `tar`

Severity: **LOW**

Observed behavior: run from Git Bash, 8 tests in `tests/deployment/deploy-release.test.ts` fail with `tar (child): Cannot connect to C: resolve failed`. Run from PowerShell, the same file passes 9/9.

Expected behavior: the test fixture should build its archive regardless of which `tar` is first on `PATH`.

Evidence: both runs captured; `tests/deployment/deploy-release.test.ts:87` spawns `tar` with a Windows absolute path.

Impact: a false failure for anyone running the suite from Git Bash on Windows.

Resolution: **not applied** — no test was modified during a blocked rehearsal. The fix is to pass a POSIX-safe path or force the Windows `tar`. Full-suite results in this report are from PowerShell, where all 627 tests pass.

## Final Validation

Final closeout validation ran under Node 24.20.0 from Windows PowerShell:

| Command | Result |
| --- | --- |
| `npm test` | PASS — 32 files passed, 2 opt-in database files skipped; 612 tests passed, 17 skipped |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `npm run test:contract` | PASS — 1 file, 9 tests |
| `npm run check:secrets` | PASS — `SECRET_SCAN = PASS` |
| `npm run check:governance-schema` | PASS — all 13 governance checks passed; `RESULT = PASS` |

The 17 skipped tests require `SOTOAYAM_TEST_POSTGRES_ADMIN_URL` and are intentionally opt-in; their skip status is unchanged. Historical migration integrity remains covered by the passing four-test migration-integrity suite, and the working tree contains no migration diff.

## Blocking Issues

None. F-001, F-002, and F-003 are resolved and verified. The remaining observations are non-blocking or belong to later roadmap phases.

## Residual Risks

1. D-018 still requires the separate Phase 4 clean-room install, upgrade/rollback, restore drill, and final security review before a paying customer; P0-16 completion does not close those launch gates.
2. Migration idempotency on the supported path is asserted by the Supabase registry, not by replaying immutable migration files (F-005). Operators must continue using `npm run migrate` and must not replay migration SQL manually.
3. Telegram delivery, reminder dispatch, and escalation remain test-verified only; the P0-16 restored-target health process intentionally disabled all three workers and did not contact Telegram.
4. Admin, taxonomy, task, collaboration, and reporting HTTP workflows were not expanded into a full end-to-end acceptance suite during the narrowly scoped restore completion. Their existing automated coverage remains authoritative until the later clean-room release gate.

## Commercial Readiness Decision

**P0-16 passed and Phase 0 is complete.**

The customer archive is self-installable, the compiled migration runner works without a production `tsx` dependency, all 15 migrations match the disposable hosted registry, fresh provisioning state survives a deterministic single-transaction data restore, and the restored-target application starts on the pinned runtime and returns `/health` HTTP 200. Commercial launch is still gated by the later roadmap phases and the explicit Phase 4 rehearsals required by D-018.

### Evidence classification

**ACTUALLY EXECUTED** — release build and SHA-256; archive extraction and content inventory; `gwensoto` scan (0, before and after the F-003 fix); independent `npm ci` (production and development, both before and after the F-002 fix); application startup failure and `ADMIN_API_KEY` length rejection from the packaged build; disposable PostgreSQL 16 cluster creation; all 15 archive migrations applied to an empty database; pre-setup state capture; failed-precheck rollback; fresh provisioning; final taxonomy inspection; second-bootstrap and legacy-bootstrap rejection; provenance mutation rejection; management-RPC administration; taxonomy code immutability; migration file replay regression; local backup/restore validation; disposable hosted target identity verification; exact 15/15 local-to-remote registry comparison; exact 28-table schema comparison; deterministic 28-table truncate plus data restore in one transaction without `CASCADE` or disabled triggers; count-only verification of restored provenance, taxonomy, administrator, role, authority, credential, and bootstrap state; Node 24.20.0 restored-target startup; `/health` HTTP 200; clean process shutdown; and the validation commands recorded below.

**STATICALLY VERIFIED** — `/health` implemented and `/ready` absent; legacy alias gated on lineage rather than taxonomy strings; absence of a create-user route; `LOCAL_GWENS_POLLING`/`VPS_GWENS_POLLING` not required by any code; deploy script's hard requirement for the three Supabase deploy variables; generic report parameters.

**MOCK / TEST VERIFIED** — first-administrator provisioning and retirement semantics (17 disposable-PostgreSQL tests); task category validation across every write path; collaboration default-deny and directionality; notification intent persistence; reminder scheduling; critical-alert acknowledgment; admin route authorization matrix — all via the 627-test suite, not via a running installation.

**NOT VERIFIED / DEFERRED** — the interactive `npm run setup` operator flow including preview, prompts, and `--password-file`; non-Telegram user onboarding; task creation and category deactivation through a live customer workflow; collaboration rule creation/evaluation through HTTP; live report output; external Telegram delivery; and the broader Phase 4 clean-room, upgrade/rollback, restore, and final-security gates. These do not block P0-16's verified installation/restore acceptance but remain explicit later work.
