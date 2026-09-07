# Sotoayam Beta Readiness

This is the operator checklist and recovery runbook for the controlled Sotoayam beta. It records the minimum safe operating contract; it does not replace automated gates or live verification for a release.

> Historical staged-installation record: named Divisi, collaboration rules, report categories, row counts, and rollout steps below describe the origin controlled beta. They are not fresh-customer installation requirements. Fresh installations use `docs/deployment/vps-production.md`; broader removal of private operational history is deferred to P0-15.

## Current recovery verification

Database logical backup and restore verification passed on 2026-09-02. The `public` application schema and data were restored into a disposable loopback-only PostgreSQL 17.11 cluster, with matching production/recovery counts, identity `MATCH=5`, 22/22 expected tables, 22 RLS-enabled tables, zero public policies, and zero orphan references. The verified artifact is retained outside Git and the VPS under restricted operator-local ACLs. See [database-recovery.md](database-recovery.md).

Supabase Dashboard backup inventory remains empty and PITR remains disabled. Controlled beta therefore depends on the documented daily logical-backup policy until an approved managed backup capability is enabled.

`DATABASE_BACKUP_VERIFICATION = PASS`

`RESTORE_DRILL = PASS`

## Gate classification

- **MUST PASS**: required before soft launch. A failure is a blocker.
- **ACCEPTABLE LIMITATION**: bounded beta risk with a documented operating control.
- **POST-BETA**: planned capability outside the current MVP.

## Authorization matrix

| Actor | Business task access | Console / operations | Explicit exclusions |
|---|---|---|---|
| STAFF | Tasks created by or assigned to the user, subject to canonical collaboration rules | `/tasks` | No governance, Owner reports, or global Divisi access |
| ADMIN | Permitted actions and visibility for the actor's own Divisi; cross-Divisi remains policy controlled | `/tasks` | No global governance merely because the role is ADMIN |
| OWNER | Business reports, Critical Alerts, and business-safe Automation Status | `/owner` | No IT infrastructure mutation and no task mutation merely because the role is OWNER |
| IT + SYSTEM_ADMIN | Normalized active IT user may perform explicit governance and technical operations | `/admin` and protected IT operational APIs | No automatic OWNER access and no automatic business-task bypass |

Telegram is only an interface. Every command, callback, and text mutation must resolve the current normalized identity and delegate business rules to canonical services.

## Soft-launch checklist

### MUST PASS

- [ ] Infrastructure: one non-root systemd process; service enabled and active; localhost bind; restart policy and journald healthy; sufficient disk and memory.
- [ ] Database: local and live migration registries match; protected tables retain RLS; no unintended public policy, drift, missing required constraint, or orphan reference.
- [ ] Backup: a current database recovery point and restoration procedure have been verified. A tested retained logical artifact satisfies this gate while managed Dashboard backup/PITR remains unavailable; the daily manual policy is mandatory.
- [ ] Telegram: VPS is the only poller; laptop polling is off; `/start`, `/admin`, `/tasks`, and `/owner` enforce current identity and private-console boundaries; callbacks acknowledge and do not stack menus.
- [ ] Identity: normalized/legacy reconciliation passes; channel mappings are unique; inactive and pending users are denied; exactly the intended active SYSTEM_ADMIN remains protected.
- [ ] Roles and Divisi: the authorization matrix passes; cross-Divisi is default-deny; `ONPAGE_B2C -> CONTENT_CREATOR` is the only approved current collaboration path and does not reveal INTERNAL owner activity.
- [ ] Tasks: creation, visibility, lifecycle, timestamps, terminal-state protection, derived overdue state, and audit activity pass through `TaskService`.
- [ ] Import: CSV bounds, dry-run, validation, partial success, idempotency, and collaboration policy pass; automation intake requires an active machine integration identity.
- [ ] Reminder and notifications: terminal tasks are excluded; dedupe, bounded retry, channel failure handling, overlap lease, and restart behavior pass.
- [ ] Reporting: `AFFILIATE_TASK_STATUS` uses owner Divisi `CONTENT_CREATOR` and canonical `task_category = AFFILIATE`; reporting windows use `BUSINESS_TIME_ZONE=Asia/Jakarta`.
- [ ] Critical Alerts: deterministic signal rules, dedupe, acknowledgement, automatic resolution, dry-run non-mutation, and evaluator lease pass.
- [ ] Rollback: current and previous versioned releases exist, the `current` symlink is valid, application rollback is health checked, and schema compatibility is assessed separately.
- [ ] Secrets: required variables exist without being printed; `.env` is ignored; repository, release artifacts, docs, and bounded logs contain no credential or temporary SSH key.
- [ ] Monitoring: IT can inspect runtime, poller, reminder scheduler, critical evaluator, notification failure, unrouted escalation, integration, and last-run state without exposing infrastructure details to OWNER.

### ACCEPTABLE LIMITATION

- Shared `ADMIN_API_KEY` and `INTERNAL_API_KEY` remain transitional credentials. APIs must remain bound to localhost and keys must be rotated after suspected exposure or operator handover.
- There is no application-wide rate limiter. Current controls are localhost-only APIs, authenticated internal routes, bounded CSV payload/rows, bounded Telegram inputs and callback data, pagination, expiring wizard state, and safe errors. Monitor repeated failures and review ingress before exposing any API.
- Unfinished Telegram wizard state is memory-only and is lost on service restart. The user can safely restart the wizard; no task is persisted before confirmation.
- Task deadlines remain canonical UTC instants and the current Telegram UI renders their date component; `BUSINESS_TIME_ZONE` governs reporting boundaries, not a separate deadline calendar. Confirm deadline semantics with beta operators until a business-calendar contract is approved.
- Report data may be sparse until legitimate categorized production tasks exist.
- Automatic OWNER escalation occurs only where an explicit routing rule is configured.

### POST-BETA

- CSV assignee resolution using a unique business identifier.
- Real ERP, BigSeller, Meta, or Shopee connectors.
- Stock and sales intelligence, advanced dashboards, or approval-engine expansion.
- AI or Hermes reasoning integration.
- WhatsApp and email delivery channels.
- Replacement of shared operational keys with identity-based API authentication and a complete API audit trail.

## IT operator runbook

### Onboard a user

1. Ask the user to send `/start` to the Sotoayam bot in a private chat.
2. Open `/admin` from the active IT SYSTEM_ADMIN account.
3. Select the pending normalized user, assign the correct Divisi and role, then activate the user through the transactional management path.
4. Ask the user to send `/start` again and confirm the active Divisi/role response. Never record or disclose the Telegram external ID.

### Deactivate or change access

1. Open `/admin`, select the normalized user, and use the canonical user-management action.
2. For a Divisi or role change, verify the intended business authority before confirming it.
3. For deactivation, confirm that current channel access is denied afterward. Never independently edit `users`, `user_channels`, and the legacy projection.
4. The final active SYSTEM_ADMIN cannot be deactivated or revoked without a valid handover.

### Inspect operational state

Use `/admin` for IT-safe status and the protected localhost operational APIs for detailed scheduler, evaluator, delivery, and integration state. Use bounded systemd logs. `/owner` must expose only business-safe status.

### Common Telegram recovery

1. Confirm the user is talking to the correct bot in a private chat.
2. Confirm the normalized user and Telegram channel are active and reconciled; do not print the external ID.
3. Confirm systemd is active, localhost health passes, and exactly one VPS poller is running.
4. If a wizard was interrupted by a restart, ask the user to reopen `/tasks`; do not reconstruct state directly in the database.
5. Investigate repeated Telegram delivery or polling errors from bounded sanitized logs before retrying.

## Release, rollback, and disaster recovery

### Application rollback

1. Confirm the previous release target is a versioned directory under `${APP_ROOT}/releases` and is compatible with the live schema.
2. Run the reviewed rollback script. It atomically repoints `current`, restarts `${SERVICE_NAME}`, and checks localhost health.
3. Verify one process, one poller, scheduler/evaluator ownership, bounded logs, and no duplicate notifications.
4. Never roll back database migration history automatically. Use a reviewed forward repair if schema repair is required.

### Rebuild on a new VPS

1. Provision the exact `.node-version` runtime, configured non-root service account, systemd unit, release/shared layout, journald, and localhost-only networking.
2. Transfer a committed, verified versioned release artifact that excludes `.env`, Git metadata, caches, logs, and credentials.
3. Restore the protected VPS-owned shared environment and confirm only required variable names are present.
4. Verify Supabase connectivity and migration compatibility before enabling production work.
5. Start with polling and schedulers disabled, verify `/health`, then enable one VPS poller and the approved schedulers in a controlled cutover.
6. Verify systemd, logs, polling uniqueness, scheduler/evaluator last runs, and Telegram smoke acceptance.

Application releases and configuration can be rebuilt from the repository and protected environment. Database rows, Telegram-side message history, in-memory wizard state, and external service state are not recoverable from an application release. Database recovery therefore requires a separately verified Supabase backup/recovery point and a restoration exercise; never infer that one exists.

## Credential inventory and rotation

Required production secret names are `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`, `INTERNAL_API_KEY`, and `ADMIN_API_KEY`. Runtime configuration also includes `HOST`, `PORT`, `TELEGRAM_POLLING_ENABLED`, `REMINDER_SCHEDULER_ENABLED`, `REMINDER_SCHEDULER_INTERVAL_SECONDS`, `BUSINESS_TIME_ZONE`, `CRITICAL_ALERT_EVALUATOR_ENABLED`, optional `CRITICAL_ALERT_POLICY_JSON`, and `LOG_LEVEL`.

The designated IT operator owns rotation: create the replacement at its source, update only the protected VPS environment, restart the single systemd service, run health and affected authentication smoke checks, then revoke the old credential. Telegram token rotation additionally requires confirming that only the VPS poller resumes. Supabase key rotation requires sanitized connectivity and server-write diagnostics. Never place credential values in commands captured by logs, documentation, Git, or release archives.

## Issue handling

Classify authorization bypass, duplicate polling, migration/RLS divergence, secret exposure, runtime crash loop, incorrect cross-Divisi access, unavailable deployment rollback, critical identity inconsistency, or an unverified database recovery point as **BLOCKER**. The current tested logical artifact closes the recovery-point blocker; failure to maintain the documented cadence reopens it. Classify bounded operational constraints above as **BETA_ACCEPTABLE** only while their controls remain true. Keep integrations and broader product capabilities as **POST_BETA**.
