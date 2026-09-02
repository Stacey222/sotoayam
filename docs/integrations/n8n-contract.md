# n8n Integration Contract

## Boundary

`External systems -> n8n -> Gwens Internal API -> canonical intake/services`

n8n is an orchestrator and transport adapter. It may schedule, fetch, normalize, transform, forward, and retry transport failures. It must not connect directly to Gwens tables or become authoritative for user roles, Divisi permissions, collaboration rules, task lifecycle, alert severity, OWNER permission, or audit history.

## Identity and authorization

- Use a dedicated machine integration identity, never a human or fake human user.
- Keep credentials outside workflows, Git, logs, payload archives, and screenshots.
- Grant only explicitly approved per-workflow capabilities after capability enforcement exists.
- Gwens derives requesting Divisi and integration identity server-side and revalidates every canonical command.
- Internal API access is not equivalent to broad authority.

## Intake and reliability

- Every create-like request carries a stable external reference for idempotency.
- Payloads use the versioned Gwens contract and explicit business classification.
- n8n retries network/transient transport failures with bounded backoff; it does not retry permanent validation or authorization failures blindly.
- Gwens remains authoritative for validation, cross-Divisi rules, ownership, lifecycle, deduplication, persistence, and audit.
- Logs contain safe correlation references only, never credentials, Telegram external IDs, or sensitive raw payloads.

## Readiness gate

Deployment is blocked until workflow ownership, hosting, network exposure, credential rotation, capability grants, payload schemas, retry limits, monitoring, and rollback/disable procedures are confirmed. Stage 1 deploys nothing.
