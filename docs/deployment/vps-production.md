# Sotoayam VPS Production

Sotoayam runs as one non-root systemd service. Hermes is a separate application and Telegram bot; its process, token, and configuration must never be reused or modified by this deployment.

## Fresh installation configuration

Deployment scripts share this small environment-variable contract:

| Variable | Fresh-install value | Requirement |
| --- | --- | --- |
| `DEPLOY_USER` | No default | Required by `bootstrap-vps.sh`; must name an existing non-root operator account. |
| `APP_ROOT` | `/opt/sotoayam` | Optional safe absolute Unix path override. `/`, relative paths, traversal, whitespace, and shell metacharacters are rejected. |
| `APP_USER` | `sotoayam` | Optional non-root system service account override. |
| `APP_GROUP` | `sotoayam` | Optional non-root system service group override. |
| `SERVICE_NAME` | `sotoayam.service` | Optional systemd `.service` unit name override; paths are rejected. |
| `HEALTH_PORT` | `3000` | Optional localhost port used by deployment and rollback health checks; set it to the runtime `PORT` when overriding that value. |

Set configuration in the invoking operator environment; no repository edit is required. Bootstrap validates all values before package installation or account/filesystem changes. For example:

```bash
export DEPLOY_USER="sotoayam-deploy"
export APP_ROOT="/opt/sotoayam"
export APP_USER="sotoayam"
export APP_GROUP="sotoayam"
export SERVICE_NAME="sotoayam.service"
export HEALTH_PORT="3000"
sudo --preserve-env=DEPLOY_USER,APP_ROOT,APP_USER,APP_GROUP,SERVICE_NAME,HEALTH_PORT bash scripts/deploy/bootstrap-vps.sh
```

The exact supported deployment runtime is recorded in `.node-version`. Bootstrap downloads that exact official Node.js archive for Linux x64 or arm64, verifies its published SHA-256 checksum, installs it without a version manager, and verifies `node --version`. Release deployment repeats the exact-version check before dependency installation or activation.

## Layout

```text
$APP_ROOT/
  releases/release-<git-sha>-<timestamp>/
  current -> releases/<active-release>/
  shared/.env
  shared/previous-release
```

The reusable deployment commands do not infer SSH accounts or home directories. Provide host, operator, and SSH configuration outside repository source. Do not embed passwords, tokens, API keys, or private keys in repository files.

## Existing legacy installation compatibility

Existing installations using compatibility-sensitive identifiers are not renamed automatically. Supply their existing values for every deployment operation:

```bash
export APP_ROOT="/opt/gwens-automation"
export APP_USER="gwens"
export APP_GROUP="gwens"
export SERVICE_NAME="gwens-automation.service"
```

The legacy paths, service account/group, and unit name remain supported inputs because renaming an active installation requires a separately reviewed cutover. They are not fresh-install recommendations. Do not rerun bootstrap over an existing installation without first reviewing ownership, systemd, sudoers, and rollback compatibility.

## Environment

`shared/.env` contains only the production values required by `src/config/env.ts`:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
TELEGRAM_BOT_TOKEN
INTERNAL_API_KEY
ADMIN_API_KEY
HOST
PORT
TELEGRAM_POLLING_ENABLED
REMINDER_SCHEDULER_ENABLED
REMINDER_SCHEDULER_INTERVAL_SECONDS
BUSINESS_TIME_ZONE
CRITICAL_ALERT_EVALUATOR_ENABLED
# CRITICAL_ALERT_POLICY_JSON (optional validated override)
LOG_LEVEL
```

Use the Sotoayam bot token, never the Hermes token. Permissions must be `0640`; only the deployment account and configured service group should be able to read it. Verify variable names without printing values.

Keep `REMINDER_SCHEDULER_ENABLED=false` on laptops. For a production cutover, deploy with the scheduler disabled, verify health and a reminder dry-run, then set it to `true` on the VPS and restart the single service process. The bounded interval defaults to 300 seconds.

Reporting uses `BUSINESS_TIME_ZONE=Asia/Jakarta` for deterministic business-date boundaries while database timestamps remain UTC.

Keep `CRITICAL_ALERT_EVALUATOR_ENABLED=false` on laptops and during the first production cutover. Run the protected IT dry-run, verify zero unintended candidates and mutations, then enable it on the VPS. It runs under the existing reminder scheduler timer with its own durable overlap lease; it does not create a second scheduler timer or send OWNER push broadcasts.

Production must set `HOST=127.0.0.1`, keeping port 3000 private to the VPS. The default `0.0.0.0` remains available for compatible local development only.

The deployment process also requires `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, and `SUPABASE_PROJECT_REF` in its own protected environment. These deploy-only values establish the non-interactive Supabase CLI link for the inactive release. Do not add them to `shared/.env`, the release archive, shell history, or systemd service environment.

## Deployment

1. Verify a clean Git checkpoint and all tests/checkers.
2. Run `scripts/deploy/package-release.ps1` locally.
3. Upload the archive, `scripts/deploy/deploy-release.sh`, and `scripts/deploy/deployment-config.sh` over SSH, preserving their relative location.
4. Provide the three deploy-only Supabase variables through the approved protected operator environment, then run the deployment script.
5. The script installs the pinned migration tooling in the inactive release, links it, runs `npm run migrate`, removes link state and development tooling, and only then atomically updates `current`.
6. The script restarts systemd and requires localhost `/health` to pass. Start the VPS first with `TELEGRAM_POLLING_ENABLED=false`.
7. Verify Supabase connectivity and the remaining runtime checks.
8. Stop the verified local Sotoayam poller.
9. Set VPS polling to `true`, restart the service, and verify one poller.

Any install, CLI, link, or migration failure exits non-zero before `current` changes or systemd restarts. A failure after migration but before activation leaves the database forward-migrated and the previous application release active; investigate compatibility before retrying. A post-activation restart or health failure exits non-zero and leaves the manual application rollback procedure below available. It never reverses database migrations automatically.

Ordinary laptop development should keep Sotoayam polling disabled whenever VPS production polling is active.

## Telegram Task Console State

The `/tasks` creation wizard, comment input, and block-reason input use bounded in-memory state. State is isolated by Telegram user, re-authorized on every callback or text input, expires after 15 minutes, and can be cancelled from the UI or with `/cancel`. A service restart intentionally clears unfinished input state; users can safely restart the wizard afterward. No task is created until the review confirmation callback succeeds.

## Service Operations

```bash
sudo systemctl status "${SERVICE_NAME}"
sudo systemctl restart "${SERVICE_NAME}"
sudo journalctl -u "${SERVICE_NAME}" -n 100 --no-pager
sudo journalctl -u "${SERVICE_NAME}" -f
curl -fsS "http://127.0.0.1:${HEALTH_PORT}/health"
```

Port 3000 is for localhost health and internal operation. Do not expose it publicly unless a separately reviewed API ingress is required. Do not expose database or Supabase-related ports.

## Rollback

Run `scripts/deploy/rollback.sh` on the VPS. It validates that the previous target remains inside `releases`, swaps `current` atomically, restarts systemd, and checks health. Database migrations are never rolled back automatically; schema compatibility must be reviewed separately.

## Security

- The service runs as the configured non-root `APP_USER` and `APP_GROUP`.
- Secrets live only in the protected shared environment file.
- systemd uses journald and process hardening.
- The deployment account has only narrowly scoped service-control sudo rules.
- Release archives exclude `.env`, `.git`, `node_modules`, logs, caches, and credentials.
- Local and VPS Sotoayam polling must never run simultaneously.
