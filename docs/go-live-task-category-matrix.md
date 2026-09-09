# Go-Live Task Category Matrix

> **INTERNAL / HISTORICAL VERIFICATION.** This origin-installation taxonomy record is engineering evidence, not customer/operator setup material. A fresh customer does not reproduce the named Divisi, category, live-task count, or report; P0-14 now provisions customer-defined taxonomy.

Task Core is authoritative. A category is supplied explicitly through `TaskService` or a canonical intake path; it must never be inferred from titles, descriptions, source references, or other free text.

| Category | Owner Divisi | Purpose | Valid creation sources | Report usage | Automation usage | Status |
|---|---|---|---|---|---|---|
| `AFFILIATE` | `CONTENT_CREATOR` | Canonical classification for affiliate work owned by Content Creator | Manual Task API, CSV import, and internal automation intake, all through canonical validation and `TaskService` | `AFFILIATE_TASK_STATUS` filters owner Divisi `CONTENT_CREATOR` and category `AFFILIATE` | Allowed only when an authorized intake explicitly supplies the category | `CONFIRMED` |

The live table currently contains one completed legacy task with a null category and no categorized `AFFILIATE` tasks. Null remains valid; no backfill is implied.

No other genuine category has been confirmed. Future workflow-specific categories are `PROPOSED_NOT_ACTIVE` until a real workflow, owner Divisi, intake contract, and reporting need are approved. No speculative category is listed or seeded here.
