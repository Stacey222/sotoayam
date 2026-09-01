# Task Ingestion Foundation

Slice 6 routes every supported source through canonical validation and `TaskService`; adapters must never insert Task Core rows directly.

## CSV import

- Endpoint: `POST /api/tasks/import/csv?dry_run=true|false`
- Content type: `text/csv; charset=utf-8`
- Authorization: configured Admin API key plus the active normalized trusted actor; the actor must have `task.import`.
- Required headers: `title`, `owner_division`.
- Optional headers: `description`, `priority`, `assignee`, `deadline`, `external_reference`.
- Limits: 256 KiB, 500 non-empty data rows, 200-character title, 10,000-character description, and 500-character external reference.
- Deadline format: strict `YYYY-MM-DD`. Priority uses `LOW`, `NORMAL`, `HIGH`, or `URGENT`.
- `owner_division` is normalized to uppercase and resolved only against an active canonical Divisi code.
- `assignee` is intentionally rejected in this MVP because normalized users do not yet have a unique, non-Telegram business identifier. No ambiguous display-name matching or raw database ID is permitted.
- `created_by_user_id` and requesting Divisi are always derived server-side. CSV may not supply them.
- `dry_run=true` performs parsing, normalization, resolution, authorization, collaboration checks, duplicate checks, and validation, but creates no task.

Only a safe client label from `x-import-label` may be retained. CSV contents and local paths are never stored or audited.

## Automation intake

- Endpoint: `POST /api/internal/tasks?dry_run=true|false`
- Authorization: the existing Internal API key plus `x-integration-code` resolving to an active `AUTOMATION` integration.
- The integration record supplies the requesting Divisi and machine audit identity. It is not a human user and stores no credential.
- Integration registration is an operational database-governance action and is intentionally not exposed as a public or self-service endpoint.

## Durable identity and observability

External references are unique within `(source, human actor)` for human imports and `(source, integration)` for machine intake. Import batches retain only initiator/integration, source, safe label, dry-run flag, counts, status, and timestamps. RLS remains enabled with no public policies.

Future ERP connectors implement `ErpTaskSourceAdapter`, normalize vendor payloads to `TaskIntakeRequest`, and then use this same service boundary. Slice 6 performs no ERP network calls.
