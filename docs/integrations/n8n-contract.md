# n8n Integration Contract

## Boundary

`External systems -> n8n -> Sotoayam Internal API -> canonical intake/services`

n8n is an orchestrator and transport adapter. It may schedule, fetch, normalize, transform, forward, and retry transport failures. It must not connect directly to Sotoayam tables or become authoritative for user roles, Divisi permissions, collaboration rules, task lifecycle, alert severity, OWNER permission, or audit history.

## Identity and authorization

- Use a dedicated machine integration identity, never a human or fake human user.
- Keep credentials outside workflows, Git, logs, payload archives, and screenshots.
- Grant only explicitly approved per-workflow capabilities after capability enforcement exists.
- Sotoayam derives requesting Divisi and integration identity server-side and revalidates every canonical command.
- Internal API access is not equivalent to broad authority.

## Intake and reliability

- Every create-like request carries a stable external reference for idempotency.
- Payloads use the versioned Sotoayam contract and explicit business classification.
- n8n retries network/transient transport failures with bounded backoff; it does not retry permanent validation or authorization failures blindly.
- Sotoayam remains authoritative for validation, cross-Divisi rules, ownership, lifecycle, deduplication, persistence, and audit.
- Logs contain safe correlation references only, never credentials, Telegram external IDs, or sensitive raw payloads.

### Notification intake idempotency

- Send a stable `event_id` with every `POST /api/notifications/send` request. Derive it from the logical business event, not the delivery attempt.
- Namespace IDs across workflows, for example `<workflow>:<run-or-business-key>:<discriminator>`. Shared-key callers currently use the server-derived `INTERNAL_API` source namespace.
- Keep event IDs opaque: never place credentials, personal data, or Telegram identifiers in them because they are persisted and used for safe correlation logs.
- An identical replay returns HTTP 200 with `duplicate=true` and does not broadcast again.
- Reusing the same event ID with changed type, message, or metadata returns `409 NOTIFICATION_EVENT_CONFLICT`; treat that as a permanent workflow defect rather than retrying blindly.
- Omitting `event_id` remains legacy-compatible but reports `idempotent=false`; a retry without a stable ID is a new logical event and may broadcast again.

## Readiness gate

Deployment is blocked until workflow ownership, hosting, network exposure, credential rotation, capability grants, payload schemas, retry limits, monitoring, and rollback/disable procedures are confirmed. Stage 1 deploys nothing.
