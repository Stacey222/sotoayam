# Go-Live Integration Registry

> **INTERNAL / HISTORICAL VERIFICATION.** This origin-installation planning snapshot is engineering evidence, not customer/operator setup material. Its zero counts and planned integration labels are not fresh-customer installation requirements or seeds.

Production currently has zero integration identities and zero active integrations. The entries below are planning records only; none exists in or is activated in production. Machine identities must never be represented by fake human users.

## Capability contract

The implemented least-privilege vocabulary currently contains only `TASK_CREATE`, because it is the only capability backed by a protected canonical machine endpoint. `TASK_READ`, `EVENT_SUBMIT`, `REPORT_DATA_SUBMIT`, and `INTEGRATION_STATUS_UPDATE` remain future unsupported concepts until corresponding canonical operations exist. No integration may receive `USER_ADMIN`, `ROLE_ADMIN`, `SYSTEM_ADMIN`, `OWNER`, or `COLLABORATION_RULE_ADMIN` through internal API access.

The `task_source_integrations` identity contains code, source (`AUTOMATION` or `ERP`), requesting Divisi, and active status. The internal automation endpoint authenticates the shared internal key, resolves an active identity, and requires an active `TASK_CREATE` grant before canonical intake.

`INTEGRATION_CAPABILITY_GAP = CLOSED`

Stage 2 implements the additive `integration_capabilities` table keyed by integration identity and capability code, with unique grants, revocation state, RLS, no public policies, and no default grants. Protected IT administration is audited. Capability never bypasses TaskService validation, collaboration, category, idempotency, or audit.

## Planned registry

| Planned code | Purpose / source | Direction | Authentication concept | Allowed capabilities to approve | Always forbidden | Expected domain | Task create | Report input | Alert input | Production status | Information required |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `N8N_MAIN` | Controlled orchestration | Bidirectional transport through Sotoayam API | Dedicated machine credential plus integration identity; secret outside Git | Per-workflow subset | All administration/authority capabilities | Canonical intake and approved events | Proposed | Proposed | Proposed | `PLANNED` | Hosting, owner, workflows, retry and credential lifecycle |
| `ERP_SOTOAYAM` | Actual ERP adapter | ERP to Sotoayam initially | ERP-supported machine auth plus Sotoayam integration identity | To be derived from discovery | All administration/authority capabilities | Products, inventory, warehouse, purchase and sales facts | `MISSING_INPUT` | `MISSING_INPUT` | `MISSING_INPUT` | `PLANNED` | Complete ERP discovery contract |
| `BIGSELLER_MAIN` | Marketplace operations source | BigSeller to Sotoayam initially | Vendor-supported machine auth plus Sotoayam integration identity | To be derived from beta use cases | All administration/authority capabilities | Orders, inventory, sales, fulfillment, listings | `MISSING_INPUT` | `MISSING_INPUT` | `MISSING_INPUT` | `PLANNED` | API availability, account scope, identifiers, rate limits |
| `META_MARKETING` | Marketing/ad performance source | Meta to Sotoayam | Vendor-supported OAuth/service mechanism | `REPORT_DATA_SUBMIT` only if approved | All task/admin capabilities unless separately approved | Aggregated campaign performance | No | Proposed | No | `PLANNED` | Product/API eligibility, metrics, account ownership, consent |
| `SHOPEE_SOURCE` | Legitimate marketplace data source | Shopee to Sotoayam | Supported partner/app mechanism | Workflow-specific, not yet approved | All administration/authority capabilities | Approved marketplace facts | `MISSING_INPUT` | Proposed | `MISSING_INPUT` | Supported API/data access and allowed use cases |
| `HERMES_AI` | Structured reasoning assistant | Sotoayam request/response | Dedicated machine credential | No canonical write by default | All authority and direct lifecycle capabilities | Structured recommendations | No | No | No | `PLANNED` | Schema, privacy, model governance, failure behavior |

Planned codes are documentation labels, not production seeds or credentials.
