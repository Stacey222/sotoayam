# Task Reminder and Notification Foundation

Slice 7 separates deterministic reminder policy, business routing, persisted notification intent, delivery state, and Telegram transport.

## Deterministic policy

Terminal and draft tasks never produce reminders. OPEN and IN_PROGRESS tasks become eligible near their deadline; BLOCKED tasks become eligible after 24 hours; overdue tasks are eligible immediately. Approach windows are LOW/NORMAL 24 hours, HIGH 48 hours, and URGENT 72 hours. Repeat intervals are LOW 24 hours, NORMAL 12 hours, HIGH 6 hours, and URGENT 2 hours.

Escalation becomes eligible after three reminders, 48 hours overdue, or 48 hours blocked. Escalation never routes to OWNER or SYSTEM_ADMIN implicitly. With no explicit rule it is stored as `ESCALATION_UNROUTED`.

## Routing and delivery

Task reminders route only to an active assigned normalized user with exactly one verified active TELEGRAM `user_channels` record. Unassigned tasks, inactive recipients, and missing or ambiguous channels are persisted as unrouted; the service never broadcasts to a Divisi or requester.

Delivery supports three bounded attempts. Transient failures retry after 5 then 15 minutes. Permanent routing failures and exhausted transient failures become FAILED. External Telegram identifiers and raw transport responses are never exposed in API status or persisted failure codes.

## Scheduler and operations

`REMINDER_SCHEDULER_ENABLED` defaults to false. `REMINDER_SCHEDULER_INTERVAL_SECONDS` defaults to 300 and accepts 60–3600. A database-backed lease with transaction advisory locking prevents overlapping evaluator ownership and expires after a bounded interval.

Protected operations:

- `GET /api/admin/notifications/status`
- `GET /api/admin/notifications/recent?limit=20`
- `POST /api/admin/notifications/evaluate?dry_run=true`

The boundary requires the Admin API key and the existing normalized SYSTEM_ADMIN actor. Dry-run reads and resolves candidates but creates no notification, changes no reminder state, and sends no Telegram message.

No routing rules are seeded. Legacy `telegram_users` notification booleans remain unchanged and continue serving only their existing compatibility contract.
