# Critical Alert Engine

Slice 9 adds a deterministic alert domain separate from Task lifecycle. It never stores `OVERDUE` as a task status, mutates a task because an alert exists, or uses AI/Hermes to classify severity.

## Supported signals and policies

| Alert type | Canonical signal | Default thresholds | Dedupe identity | Resolution |
| --- | --- | --- | --- | --- |
| `TASK_OVERDUE` | Active task deadline before current time | WARNING 1h, HIGH 24h, CRITICAL 72h; HIGH/URGENT priority raises one level after the warning boundary | type + task + policy version | Task is no longer active-overdue |
| `TASK_BLOCKED_TOO_LONG` | Current `BLOCKED` task plus latest append-only `TASK_STATUS_CHANGED` audit whose target is `BLOCKED` | WARNING 4h, HIGH 24h, CRITICAL 72h; HIGH/URGENT priority raises one level | type + task + policy version | Task leaves `BLOCKED` |
| `NOTIFICATION_DELIVERY_FAILURE` | Delivery reached canonical `FAILED`; transient retries below that state are ignored | WARNING by default, HIGH for permanent or 3+ attempts, CRITICAL for 5 attempts | type + delivery + policy version | Delivery is no longer failed |
| `REMINDER_SCHEDULER_UNHEALTHY` | Expected scheduler is failed or its canonical completion is stale | HIGH after 15m stale, CRITICAL after 60m; explicit failure is HIGH | type + scheduler singleton + policy version | Scheduler returns to recent `COMPLETED` |

`NORMAL` observations are diagnostic and are not persisted or shown to OWNER. Persisted severities are `WARNING`, `HIGH`, and `CRITICAL`. Task priority/category may supply explicit `BUSINESS_IMPACT`; no revenue, stock, velocity, or strategic score is fabricated. `VALUE` remains a supported dimension for future canonical signals but is unused in the MVP.

Defaults are centralized in `src/alerts/policy.ts`. A deployment may provide one validated `CRITICAL_ALERT_POLICY_JSON` override. Unknown keys, non-positive values, and unordered thresholds fail startup.

## Lifecycle and privacy

Active dedupe is database-backed and concurrency-safe. Repeated detection refreshes one `OPEN` or `ACKNOWLEDGED` alert and increments its occurrence count. Disappearing conditions become `RESOLVED`; history is retained. OWNER acknowledgement records who saw the alert but does not resolve it.

OWNER receives business-safe summaries and structured context only. Raw errors, task activities, Telegram identifiers, secrets, filesystem paths, and audit payloads are never returned. Alert visibility is separate from push routing; Slice 9 sends no automatic OWNER broadcast.

The evaluator uses the existing reminder scheduler timer and a separate durable lease/state row for overlap protection and health. Laptop evaluation is disabled by default. Production is enabled only after a non-mutating dry-run is reviewed.

Automation Status reports runtime/polling state, scheduler/evaluator health, delivery health, and the canonical active-integration count. The current integration schema has no reliable normalized failure timestamp/state, so Slice 9 does not fabricate a “recent integration failure” metric.
