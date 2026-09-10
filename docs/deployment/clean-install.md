# Sotoayam Clean Installation

This guide installs a new Sotoayam instance for one customer, from the release package to a running system with the customer's own divisions, categories, and collaboration rules.

Every Sotoayam instance serves one customer and owns its own database.

## Requirements

| Requirement | Value |
| --- | --- |
| Server | One small Linux VPS (x64 or arm64), non-root operator account with `sudo` |
| Node.js | Exactly the version in `.node-version` (currently `24.20.0`). Installed automatically by `scripts/deploy/bootstrap-vps.sh`; deployment refuses any other version |
| Database | A Supabase project (PostgreSQL). Sotoayam connects through the Supabase API, so a plain PostgreSQL server is not sufficient |
| Telegram | One bot token from BotFather, dedicated to this instance. Not required to install — only to use Telegram features |
| Local tools | `tar`, `ssh`, and PowerShell (to build the release package) |
| Database tools | `pg_dump`, `pg_restore`, and `psql`, major version at least that of your database, for backups |

Before you begin, create the Supabase project and note its project reference, database password, and service role key. Keep them out of shell history and version control.

## Release Package

Build the package on your workstation:

```powershell
powershell -NoProfile -File scripts\deploy\package-release.ps1 -OutputPath C:\path\to\sotoayam-release.tar.gz
```

The package contains the compiled application, the admin web assets, the migration files, the migration runner, and the deployment helper scripts. It deliberately contains no `.env`, no secrets, and no database identity.

Copy three things to the server, keeping their relative locations:

- the `.tar.gz` package;
- `scripts/deploy/deploy-release.sh`;
- `scripts/deploy/deployment-config.sh`.

Prepare the server once, before the first deployment:

```bash
export DEPLOY_USER="sotoayam-deploy"
export APP_ROOT="/opt/sotoayam"
export APP_USER="sotoayam"
export APP_GROUP="sotoayam"
export SERVICE_NAME="sotoayam.service"
export HEALTH_PORT="3000"
sudo --preserve-env=DEPLOY_USER,APP_ROOT,APP_USER,APP_GROUP,SERVICE_NAME,HEALTH_PORT \
  bash scripts/deploy/bootstrap-vps.sh
```

This creates the service account, the directory layout, and installs the exact supported Node.js version.

## Environment Configuration

Create `${APP_ROOT}/shared/.env` from `.env.example` in the repository, then replace every placeholder. Set file permissions to `0640`, owned by the deployment account and readable by the service group. Never commit it, never place it in the release package.

| Variable | Class | Notes |
| --- | --- | --- |
| `SUPABASE_URL` | **Required** | Your Supabase project API URL |
| `SUPABASE_SERVICE_ROLE_KEY` | **Required** | Service role or secret key. Server-side only. The alias `SUPABASE_SERVICE_KEY` is accepted for older installations |
| `TELEGRAM_BOT_TOKEN` | **Required** | Required even when polling is off. Use this instance's own bot |
| `INTERNAL_API_KEY` | **Required** | Temporary shared secret for legacy internal callers during integration-credential Stage A |
| `INTERNAL_API_KEY_FALLBACK_ENABLED` | Optional | Defaults to `true` for zero-downtime upgrades. Disable only after the credential usage gate passes |
| `ADMIN_API_KEY` | Conditional | Required only when `ADMIN_API_KEY_FALLBACK_ENABLED=true`; when present it must contain at least 32 characters |
| `HOST` | Optional | Defaults to `127.0.0.1`. Keep the port private to the server |
| `PORT` | Optional | Defaults to `3000`. Match `HEALTH_PORT` if you change it |
| `TELEGRAM_POLLING_ENABLED` | Optional | `true` or `false`. See **Telegram Setup** |
| `REMINDER_SCHEDULER_ENABLED` | Optional | `true` or `false`. Enables automatic reminder evaluation |
| `REMINDER_SCHEDULER_INTERVAL_SECONDS` | Optional | 60–3600, default 300 |
| `CRITICAL_ALERT_EVALUATOR_ENABLED` | Optional | `true` or `false`. Requires the reminder scheduler to be enabled |
| `CRITICAL_ALERT_POLICY_JSON` | Optional | Validated policy override |
| `BUSINESS_TIME_ZONE` | Optional | Defaults to `UTC`. Choose the customer's zone; stored timestamps stay UTC |
| `LOG_LEVEL` | Optional | Defaults to `info` |
| `SESSION_ABSOLUTE_TTL_SECONDS` | Optional | Defaults to `43200` (12 hours); allowed 900â€“604800 |
| `SESSION_IDLE_TTL_SECONDS` | Optional | Defaults to `3600`; allowed 300 through the absolute TTL |
| `SESSION_COOKIE_SECURE` | Optional | Defaults to `true`. Production requires HTTPS; `false` is accepted only when `HOST` is loopback and `TRUST_PROXY=false` |
| `TRUST_PROXY` | Optional | Defaults to `false`; set `true` only behind the trusted TLS reverse proxy so login throttling sees the client IP |
| `ADMIN_API_KEY_FALLBACK_ENABLED` | Optional | Stage B compatibility fallback, default `false`. Enabling it is temporary and emits a startup warning |
| `RATE_LIMIT_ENABLED` | Optional | Defaults to `true`; emergency kill switch for the in-memory availability limiter only |
| `RATE_LIMIT_LOGIN_PER_MINUTE` | Optional | 1–120, default 5 per client IP |
| `RATE_LIMIT_LOGIN_GLOBAL_PER_MINUTE` | Optional | 10–6000, default 60 across the process |
| `RATE_LIMIT_ADMIN_READ_PER_MINUTE` | Optional | 30–6000, default 300; admin reads only. Auth session reads are fixed at 120/min |
| `RATE_LIMIT_ADMIN_WRITE_PER_MINUTE` | Optional | 5–1200, default 60 |
| `RATE_LIMIT_ADMIN_EXPENSIVE_PER_MINUTE` | Optional | 1–600, default 10 |
| `RATE_LIMIT_INTERNAL_PER_MINUTE` | Optional | 30–20000, default 600 |
| `RATE_LIMIT_AUTH_FAILURE_PER_MINUTE` | Optional | 3–600, default 30 per client IP |
| `RATE_LIMIT_SHARED_ORIGIN_FACTOR` | Optional | 1–100, default 10; IP-only multiplier when loopback plus `TRUST_PROXY=false` collapses origins |
| `RATE_LIMIT_MAX_KEYS` | Optional | 1000–200000, default 10000 |
| `RATE_LIMIT_TRUSTED_IPS` | Optional | Empty by default; comma-separated exact IP addresses (IPv6 entries compare at /64) |
| `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_REF` | **Deploy-time only** | Required by the deployment script to reach your database. Supply them in the operator's protected environment. **Never** put them in `shared/.env`, the package, or shell history |
| `SOTOAYAM_BOOTSTRAP_ADMIN_PASSWORD` | **Setup-time only** | Optional automation fallback for the first-administrator password. Prefer `--password-file` or the prompt. Remove it immediately after setup |

Validate the file before deploying:

```bash
bash scripts/deploy/install-env.sh
```

It checks the shape of the configuration and requires each operational flag to be explicitly `true` or `false`. It never prints values.

## PostgreSQL Setup

Sotoayam uses your Supabase project's PostgreSQL database. You do not create schemas or tables by hand — the migrations do that.

Do not point Sotoayam at a shared or pre-existing application database. One instance, one database.

## Run Migrations

Migrations are applied by the deployment script, which links the release to your Supabase project and runs the ordered migration command before activating the new version:

```bash
export SUPABASE_ACCESS_TOKEN="..." SUPABASE_DB_PASSWORD="..." SUPABASE_PROJECT_REF="..."
bash scripts/deploy/deploy-release.sh sotoayam-release.tar.gz release-<git-sha>-<timestamp>
```

The script prints `MIGRATION_GATE=PASS` on success. If migration fails, the previous version stays active and the service is not restarted.

The underlying command is `npm run migrate`. It discovers every migration file, verifies the ordering, and applies only the ones your database has not seen, so running the deployment again is safe.

Run migrations through `deploy-release.sh` rather than invoking `npm run migrate` yourself on an already-activated release. The migration runner itself ships compiled and needs no development tooling to start, but the Supabase CLI it drives is installed only for the duration of the deployment script and removed again before activation — a running installation does not keep it around.

**Never apply migration files by hand.** Replaying them outside the migration registry can reintroduce starter data that setup already removed. Always use `npm run migrate` through the deployment script.

## First Administrator Setup

Run this **exactly once** per installation, after migrations, as the service account with the runtime environment loaded:

```bash
sudo -u "${APP_USER}" node --env-file="${APP_ROOT}/shared/.env" \
  "${APP_ROOT}/current/dist/src/cli/setup.js" \
  --fresh-install --division-name "Operations" --division-code OPERATIONS
```

Setup requires you to state which kind of installation this is. There is no default and it never guesses:

- `--fresh-install` — a new customer on a new database;
- `--keep-existing-taxonomy --division-code EXISTING_DIVISION` — an existing installation being brought onto this version.

Before asking for a password, setup prints a read-only `SETUP_PREVIEW`. Read it and confirm it describes what you expect.

**Password handling.** Setup prompts with no echo and asks for confirmation. For automation use `--password-file` pointing at a protected file that you delete immediately afterwards. There is deliberately no `--password` argument — passwords must never appear in shell history or process listings.

Successful output:

```text
FIRST_ADMIN_CREATED user_id=<id> email=<normalized-email>
authority=SYSTEM_ADMIN division=OPERATIONS role=ADMIN
```

The first administrator gets the `ADMIN` role and `SYSTEM_ADMIN` authority. They do not get `OWNER`, and they do not need a Telegram account.

Setup is a single transaction: either everything is created or nothing is. If it fails, fix the cause and run it again. Once it has succeeded it can never run again — a second attempt exits with `FIRST_ADMIN_ALREADY_EXISTS` (exit code 3) without prompting for a password. Setup is not an account-recovery tool.

## Fresh vs Existing Installation

| | Fresh installation | Existing installation |
| --- | --- | --- |
| Command | `--fresh-install` with a division name and code | `--keep-existing-taxonomy` with an existing active division code |
| Divisions after setup | Only the one you named | Every existing division, unchanged |
| Starter data | Removed | Kept exactly as-is |
| Your data | None yet | Nothing is deleted, renamed, or deactivated |

A fresh installation ships with a small set of starter divisions so the database is never empty mid-install. Choosing `--fresh-install` tells Sotoayam this database belongs to a new customer, and setup removes that starter data in the same transaction that creates your first division and your administrator.

Setup will refuse to remove anything if it finds *any* sign the installation is already in use — a user, a task, a Telegram registration, a changed starter row, or anything referencing one. In that case it makes no changes at all. Your choice is recorded permanently and cannot be altered afterwards, so make it deliberately.

## Start Sotoayam

The deployment script restarts the service and requires a health check to pass. Afterwards, **restart the service once more** so it picks up the new installation record:

```bash
sudo systemctl restart "${SERVICE_NAME}"
curl -fsS "http://127.0.0.1:${HEALTH_PORT}/health"
```

Expected: `{"status":"ok"}`.

This restart is required after fresh setup. Skipping it leaves an obsolete legacy report route registered until the next restart.

Confirm the installation is administratively ready by opening the HTTPS admin URL and signing in with the email and password created by setup. The browser receives a short-lived `HttpOnly` session cookie; it never receives `ADMIN_API_KEY`.

The following server-side check requires an explicit temporary compatibility opt-in (`ADMIN_API_KEY_FALLBACK_ENABLED=true`) and is not the daily administrator login path. Before opting in, use `npm run check:admin-key-usage -- --since <ISO timestamp>` to inspect recorded fallback usage:

```bash
curl -fsS -H "X-Admin-Api-Key: ${ADMIN_API_KEY}" \
  "http://127.0.0.1:${HEALTH_PORT}/api/admin/system-authority/status"
```

Routine service operations:

```bash
sudo systemctl status "${SERVICE_NAME}"
sudo journalctl -u "${SERVICE_NAME}" -n 100 --no-pager
```

## First Company Configuration

All human administration goes through the same-origin web UI using the signed-in administrator's opaque server session. Session identity is revalidated on every request and audit rows name that administrator. State-changing requests also require the session-bound CSRF token handled by the UI.

The `X-Admin-Api-Key` examples below are retained only for explicitly enabled compatibility. The Stage B default is `false`; when temporarily enabled, use is observed in logs/audit and a deprecation warning appears at every startup. New human workflows must use login sessions.

Create the divisions your business actually has:

```bash
curl -fsS -X POST "http://127.0.0.1:${HEALTH_PORT}/api/admin/divisions" \
  -H "X-Admin-Api-Key: ${ADMIN_API_KEY}" -H "Content-Type: application/json" \
  -d '{"code":"SALES","name":"Sales"}'
```

| Action | Endpoint |
| --- | --- |
| List divisions | `GET /api/admin/divisions` |
| Create division | `POST /api/admin/divisions` |
| Rename or deactivate division | `PATCH /api/admin/divisions/:id` |
| Delete an unused division | `DELETE /api/admin/divisions/:id` |
| List roles | `GET /api/admin/roles` |
| Rename a role's display name | `PATCH /api/admin/roles/:id` |
| List task categories | `GET /api/admin/task-categories` |
| Create task category | `POST /api/admin/task-categories` |
| Rename or deactivate category | `PATCH /api/admin/task-categories/:id` |
| Delete an unused category | `DELETE /api/admin/task-categories/:id` |
| List collaboration rules | `GET /api/admin/collaboration-rules` |
| Create collaboration rule | `POST /api/admin/collaboration-rules` |
| Change a rule | `PATCH /api/admin/collaboration-rules/:id` |
| Deactivate a rule | `DELETE /api/admin/collaboration-rules/:id` |

Rules to know:

- **A division or category code is permanent.** Display names can change at any time; codes cannot, because your automation refers to them.
- **Roles are fixed.** `STAFF`, `ADMIN`, and `OWNER` ship with the product. You may rename what they are called; you cannot add, delete, or deactivate roles in this version.
- **Deleting requires being unused.** If anything references a division or category, the API refuses and tells you to deactivate it instead. Deactivating preserves history and blocks new use.
- **Cross-division work is denied by default.** Nothing crosses division boundaries until you create a rule, and rules are one-directional: `SALES → WAREHOUSE` does not permit `WAREHOUSE → SALES`.
- **Categories are optional.** Until you create one, tasks simply have no category. Once your catalog has entries, a task's category must be one of the active ones, or empty.

Sample starter configurations live under `presets/`. They are reference data you may copy from by hand; nothing is applied automatically.

## Telegram Setup

Telegram is not required to install Sotoayam, and it is not required to create your first administrator.

1. Create a bot with BotFather and put the token in `TELEGRAM_BOT_TOKEN`.
2. Set `TELEGRAM_POLLING_ENABLED=true` — only when this instance's bot is not being polled by any other process.
3. Restart the service. Polling starts and stops with the process; there is no runtime toggle.

**Never run two pollers on one bot token.** If you also run Sotoayam on a laptop, that copy must have `TELEGRAM_POLLING_ENABLED=false`.

Staff join by sending `/start` to the bot. That creates an inactive, unassigned user record. An administrator then assigns division, role, and active status:

```bash
curl -fsS "http://127.0.0.1:${HEALTH_PORT}/api/admin/users?status=pending" \
  -H "X-Admin-Api-Key: ${ADMIN_API_KEY}"

curl -fsS -X PATCH "http://127.0.0.1:${HEALTH_PORT}/api/admin/users/<id>/access" \
  -H "X-Admin-Api-Key: ${ADMIN_API_KEY}" -H "Content-Type: application/json" \
  -d '{"division_id":<id>,"role_id":<id>,"active":true}'
```

Note that this is the only way to add a person: they message the bot first, you assign them afterwards. The first administrator, created by setup, is the one account that exists without Telegram.

If an administrator password must be recovered, run the server-only command as the service account. It prompts without echo, enforces the same password policy, revokes every session for the account, and writes an audit row:

```bash
sudo -u "${APP_USER}" node --env-file="${APP_ROOT}/shared/.env" \
  "${APP_ROOT}/current/dist/src/cli/admin-reset-password.js" --email admin@example.com
```

For controlled automation, add `--password-file /protected/path` and delete that protected file immediately afterward. There is no HTTP password-reset endpoint.

## First Task

Create a category, then a task in one of your divisions:

```bash
curl -fsS -X POST "http://127.0.0.1:${HEALTH_PORT}/api/admin/task-categories" \
  -H "X-Admin-Api-Key: ${ADMIN_API_KEY}" -H "Content-Type: application/json" \
  -d '{"code":"GENERAL","name":"General"}'
```

Tasks can be created from the Telegram `/tasks` console, through the task API, or by CSV and automation intake. A task's owning division must be one of your divisions, and its category must be an active one from your catalog or empty.

Deactivating a category later does not affect existing tasks — they stay readable and reportable. It only stops the category being used on new ones.

## Reporting

```bash
curl -fsS -H "X-Admin-Api-Key: ${ADMIN_API_KEY}" \
  "http://127.0.0.1:${HEALTH_PORT}/api/reports/task-status?division=WAREHOUSE&task_category=GENERAL&window=LAST_7_DAYS"
```

| Parameter | Meaning |
| --- | --- |
| `division` | Optional division code. Omit for all divisions you may view |
| `task_category` | Optional category code. Omit for all categories |
| `window` | `TODAY`, `LAST_7_DAYS`, or `LAST_30_DAYS` |
| `statuses` | Optional comma-separated task statuses |

The report returns totals by status with overdue and upcoming counts, and supports drill-down through `detail` and `page`. It works with whatever divisions and categories you defined — no particular division or category is required.

## Backup

Take a backup before every deployment or migration, and at least daily.

```bash
pg_dump --format=custom --schema=public --no-owner --no-acl \
  --file=/protected/backups/sotoayam-backup-$(date -u +%Y%m%d).dump
```

Supply the connection through the environment or an authorized Supabase CLI session. Never put a password or connection URI on the command line.

After every backup:

1. `pg_restore --list <file>` and require exit code 0;
2. record the UTC timestamp, byte size, and SHA-256 checksum;
3. store it outside Git and outside the server, with restricted permissions.

Keep at least seven daily recovery points plus the latest pre-migration one. Full detail is in `docs/database-recovery.md`.

## Restore

Restore only into an isolated, non-production target. Confirm it is not production before running anything.

```bash
psql "<recovery-target>" --set ON_ERROR_STOP=1 --command "drop schema public cascade;"
pg_restore --exit-on-error --no-owner --no-acl --dbname="<recovery-target>" <backup.dump>
```

Require exit code 0. Then verify: the expected tables and functions exist, row-level security is enabled on every application table, no policy grants public access, and your row counts match.

A recovery drill should be run at least monthly and before any high-risk migration. Never point a production Telegram bot at a recovery target.

## Integration Credentials

Create the first machine credential from the protected server after the integration identity exists:

```bash
npm run integration:credential -- --code ERP_SYNC --label "n8n production" --email admin@example.com
```

The command prints the `soto_ik_<selector>_<secret>` value exactly once. Put it directly into the integration's protected secret store and send it only in `X-Integration-Key`; never put it in a URL, log, repository, or database field. `X-Integration-Code` is optional and, when supplied, must agree with the credential owner. It never authenticates by itself.

The CLI requires the email of the active SYSTEM_ADMIN who performs the operation and never chooses arbitrarily when multiple administrators exist.

Rotate with overlap: create a second credential, deploy it to the caller, make a real request, wait more than 60 seconds, and confirm the new row has a non-null `last_used_at` through `GET /api/admin/integrations/:id/credentials`. Only then revoke the old credential with `POST /api/admin/integrations/:id/credentials/:credentialId/revoke`. Two active credentials is the hard maximum. Use immediate revocation for compromise; `grace_seconds` from 1 through 604800 is for planned retirement only. Grace cannot reactivate an expired credential and can only shorten an existing future expiry.

Existing internal callers continue through `INTERNAL_API_KEY_FALLBACK_ENABLED=true`. After migration, run `npm run check:integration-credentials -- --since <upgrade-ISO-timestamp>`. Disable the fallback only when it reports `SAFE TO DISABLE FALLBACK`; the gate requires an observed credential for every active integration and no legacy fallback audit since the supplied timestamp.

## Upgrade

1. Take a backup and verify its checksum.
2. Build the new release package.
3. Upload it with the two deploy scripts.
4. Run `deploy-release.sh` with the deploy-time Supabase variables set. It installs the new release, runs migrations, and only then switches to the new version.
5. Confirm health, then confirm your divisions, categories, and rules are unchanged.

P1-04 changes `ADMIN_API_KEY_FALLBACK_ENABLED` to default `false`. Human administrators continue through sessions. If an old server-side script still needs the shared administrator key, temporarily set the flag to `true` and supply an `ADMIN_API_KEY` of at least 32 characters; every startup warns while this opt-in remains. Use `npm run check:admin-key-usage -- --since <upgrade-ISO-timestamp>` to identify recorded use before removing that opt-in.

Do **not** run setup again — it is refused after the first installation.

Migrations only move forward. Application rollback with `scripts/deploy/rollback.sh` switches back to the previous release, but it does not undo database changes; check schema compatibility before rolling back.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `ADMIN_API_KEY must be at least 32 characters` | The temporary compatibility key is too short. Generate a longer random value and restart |
| Login repeatedly returns `401 INVALID_CREDENTIALS` | Email, password, and inactive-account failures deliberately have one response. Verify the account through an authorized server-side process |
| Login returns `429 LOGIN_THROTTLED` | The bounded cooldown is active. Wait for `Retry-After`; do not weaken the gate |
| Browser login works on localhost but not production | Production cookies require HTTPS. Keep `SESSION_COOKIE_SECURE=true` and fix the TLS/reverse-proxy path |
| `Missing required environment variable: <name>` | Add it to `shared/.env` and restart |
| `Cannot find project ref. Have you run supabase link?` | The deploy-time Supabase variables are missing or wrong. Migration needs them |
| `Unable to load installation provenance` | The application cannot reach the database. Check `SUPABASE_URL` and the service role key |
| `FIRST_ADMIN_ALREADY_EXISTS` (exit 3) | This installation already has an administrator. Setup is not a recovery tool |
| `TAXONOMY_UNAVAILABLE` (exit 7) | Migrations have not been applied, or the named division does not exist. Run migrations first |
| Setup refuses to remove starter data | It found evidence the database is already in use. Confirm whether this is genuinely a new customer; if it is an existing installation, use `--keep-existing-taxonomy` |
| `409` when deleting a division or category | Something still references it. Deactivate instead |
| Telegram messages arrive twice | Two processes are polling one bot token. Set `TELEGRAM_POLLING_ENABLED=false` on all but one |
| An old report route is still visible after fresh setup | Restart the service once after setup |

## Security Notes

- The service runs as a non-root account. Keep it that way.
- Human administrators use their own password and revocable server session. Logout and password rotation take effect in the database without a cache window.
- `ADMIN_API_KEY` is a temporary Stage B compatibility fallback and is disabled by default. If explicitly enabled, treat it as a server secret: at least 32 random characters, unique to this installation, and remove the opt-in after usage checks are clear.
- Keep `PORT` bound to `127.0.0.1` and put a trusted reverse proxy with TLS in front of it. Secure administrator cookies are intentionally unusable over plain external HTTP.
- Behind that proxy, set `TRUST_PROXY=true` and configure the proxy to overwrite rather than append `X-Forwarded-For`. Never enable proxy trust on a directly reachable application port: a client-controlled forwarding header bypasses IP budgets and expands limiter key cardinality. With loopback plus `TRUST_PROXY=false`, Sotoayam warns and applies shared-origin limits because all clients appear as one IP.
- Rate-limit counters are process-local and reset on restart. Durable password cooldown remains in `admin_login_attempts`; `RATE_LIMIT_ENABLED=false` disables only volume limiting and never authentication.
- Secrets belong only in `shared/.env` with `0640` permissions. Never in the release package, Git, shell history, or systemd unit files.
- Deploy-time Supabase variables and the setup password are supplied for one command and removed immediately afterwards.
- Do not expose the database or any Supabase port publicly.
- Every administrative change is written to an append-only audit log.
