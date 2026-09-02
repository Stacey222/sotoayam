# Go-Live Notification Routing

Observed production routing rules: zero configured and zero active `notification_routing_rules`. The table currently supports explicit `TASK_ESCALATION` routes to one specific user. Missing routes remain `UNROUTED`.

| Event | Recipient authority | Recipient selection | Channel | Automatic? | Configured? | Fallback | Unrouted behavior |
|---|---|---|---|---:|---:|---|---|
| Task reminder | Active normalized task assignee | Exactly one active, verified Telegram channel for the assigned eligible user | Telegram | Yes | Canonical behavior active | None | No delivery; reason is recorded by the evaluator |
| Critical alert visibility | Active `OWNER` | OWNER console/API request | OWNER console/API | No (pull) | Yes | None | Not broadcast |
| Critical alert push | Not confirmed | Not selected | None | No | No | None | `UNROUTED` |
| Task escalation | No authority implied | Explicit active rule by owner Divisi and optional priority, selecting one eligible user | Rule channel; runtime currently supports Telegram delivery | Yes when a matching rule exists | No live rules | None | `ESCALATION_UNROUTED`; never broadcast to OWNER, SYSTEM_ADMIN, or a whole Divisi |
| System operational failure | Active IT `SYSTEM_ADMIN` for protected operations; OWNER for automation status/critical visibility | Authorized operator explicitly queries protected API/console | API/console | No push contract | Visibility is configured; push is not | Critical signal remains queryable | No guessed recipient |
| Owner report | Active `OWNER` | OWNER requests `/owner` report | Telegram interface | No (pull) | Yes | None | No scheduled or automatic report |
| Integration failure | Not confirmed | No active integration route | None | No | No | Operational status only where applicable | `UNROUTED` |

## Escalation policy currently implemented

- Candidate after three reminders, 48 overdue hours, or 48 blocked hours.
- Repeat escalation interval: 24 hours.
- Route must be explicitly configured for the owner Divisi and optional priority.
- Recipient must be an active normalized user with exactly one active Telegram channel.
- There is no default OWNER, SYSTEM_ADMIN, or whole-Divisi fallback.

Business confirmation is required for recipient, priority scope, channel, and operational ownership before any live route is inserted.
