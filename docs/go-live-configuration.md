# Go-Live Configuration Workbook

Snapshot date: 2026-09-02. Status values mean exactly `CONFIRMED`, `MISSING_INPUT`, `PROPOSED`, or `NOT_REQUIRED_FOR_BETA`; proposed items are not authorization to implement them.

## Current canonical inventory

- `CONFIRMED`: 5 normalized users; 3 active and 2 pending.
- `CONFIRMED`: active assignments comprise one IT/ADMIN, one MANAGEMENT/OWNER, and one CONTENT_CREATOR/STAFF; two pending users remain unassigned. Counts intentionally omit personal identifiers.
- `CONFIRMED`: 5 active, verified Telegram channel mappings.
- `CONFIRMED`: one active `SYSTEM_ADMIN` and one active `OWNER`.
- `CONFIRMED`: all nine canonical Divisi are active: `PURCHASING`, `SALES_GROSIR`, `DIGITAL_MARKETING`, `CONTENT_CREATOR`, `ONPAGE_B2C`, `SHOPEE_LIVE`, `GUDANG`, `MANAGEMENT`, and `IT`.
- `CONFIRMED`: one active collaboration rule, `ONPAGE_B2C -> CONTENT_CREATOR`, allowed, no approval, scope `ALL`.
- `CONFIRMED`: one completed legacy task with null category; `AFFILIATE` is supported but has zero live tasks.
- `CONFIRMED`: zero integration identities, zero active integrations, and zero notification routing rules.
- `CONFIRMED`: report `AFFILIATE_TASK_STATUS` uses owner Divisi `CONTENT_CREATOR`, category `AFFILIATE`, and configured business timezone boundaries.
- `CONFIRMED`: critical alert types cover overdue task, long-blocked task, notification delivery failure, and unhealthy reminder scheduler.

## A. Users

| Decision | Status | Required input / fact |
|---|---|---|
| Active user roster | `MISSING_INPUT` | Confirm the two pending people and whether each should be onboarded; do not expose channel identifiers. |
| Divisi and role per person | `MISSING_INPUT` | Business owner must approve each pending assignment. |
| Business identifier | `CONFIRMED` | Nullable unique `users.business_user_code`, stable and business-controlled. Existing users remain valid without a code. |

`BUSINESS_USER_IDENTIFIER_GAP = CLOSED`: the additive Stage 2 contract provides strict normalization, partial uniqueness, canonical resolution, protected IT administration, audit, and CSV/intake assignment without Telegram/email dependency. No production code is generated or backfilled automatically.

## B. Collaboration

| Decision | Status |
|---|---|
| `ONPAGE_B2C -> CONTENT_CREATOR`, allowed, no approval, `ALL` | `CONFIRMED` |
| Every other cross-Divisi relationship | `MISSING_INPUT` |

Missing relationships remain denied.

## C. Task categories

| Decision | Status |
|---|---|
| `AFFILIATE`, owned by `CONTENT_CREATOR` | `CONFIRMED` |
| Additional real business categories | `MISSING_INPUT` |

No category may be inferred from free text and no speculative category is active.

## D. Notification routing

| Decision | Status |
|---|---|
| Task reminder to assigned eligible user through Telegram | `CONFIRMED` |
| Critical alert visibility through OWNER console/API | `CONFIRMED` |
| Critical alert push recipient/channel | `MISSING_INPUT` |
| System operational failure push | `MISSING_INPUT` |
| Scheduled OWNER reports | `NOT_REQUIRED_FOR_BETA` |
| Integration failure push | `MISSING_INPUT` |

## E. Escalation

| Decision | Status |
|---|---|
| Candidate thresholds: 3 reminders, 48 overdue hours, or 48 blocked hours; repeat after 24 hours | `CONFIRMED` as current technical defaults; business calibration is `MISSING_INPUT` |
| Recipient by owner Divisi/priority and channel | `MISSING_INPUT` |
| Default broadcast fallback | `NOT_REQUIRED_FOR_BETA`; current behavior stays `UNROUTED` |

## F. Integration priorities

| Integration | Status | Decision needed |
|---|---|---|
| n8n | `PROPOSED` | Hosting, workflow owner, first workflow, capability, schemas, and operations |
| ERP | `MISSING_INPUT` | Complete ERP discovery |
| BigSeller | `MISSING_INPUT` | Confirm beta use case and supported access |
| Meta | `MISSING_INPUT` | Confirm legitimate data access and required metrics |
| Shopee | `MISSING_INPUT` | Confirm supported API/data path and use case |
| Hermes | `NOT_REQUIRED_FOR_BETA` | Revisit only after canonical data/routing is stable |

`INTEGRATION_CAPABILITY_GAP = CLOSED`: the internal task endpoint now requires the shared internal key, an active registered integration identity, and active `TASK_CREATE`. Capability administration is restricted to active IT `SYSTEM_ADMIN`; revoked/missing capabilities deny immediately. No production identity or grant is seeded.

## G. Business reporting

| Decision | Status |
|---|---|
| `AFFILIATE_TASK_STATUS` OWNER report | `CONFIRMED` |
| Canonical timezone `Asia/Jakarta` | `CONFIRMED` in code/config contract; verify deployed value during any runtime change |
| Consumers beyond OWNER, cadence, and external source inputs | `MISSING_INPUT` |
| Scheduled OWNER reporting | `NOT_REQUIRED_FOR_BETA` |

## H. Critical alerts

Current default policy is `PROPOSED` for business confirmation: overdue 1/24/72 hours, blocked 4/24/72 hours, scheduler stale/critical at 15/60 minutes. Runtime behavior is implemented, but business stakeholders must confirm thresholds and any future push routing before changes.

## Meta, Shopee, and Hermes boundaries

- Meta is a planned business/ad performance source only.
- Shopee is a planned marketplace source only where supported access and legitimate use are confirmed.
- Hermes is a planned reasoning layer only: `Sotoayam -> reasoning request -> Hermes -> structured recommendation -> Sotoayam validation -> authorized action`. Hermes is never canonical authority.

## Backup operating policy

`CONFIRMED`: manual logical backup before major migration/deployment; daily logical backup while managed backup/PITR is unavailable; at least seven daily points plus latest pre-migration point; SHA-256 checksum; protected storage outside Git and VPS; second approved location when available; monthly and pre-high-risk restore drills.

`DAILY_BACKUP_AUTOMATION = PENDING`. Secure credential source, encrypted destination, retention, monitoring, and failure ownership must be approved before automation.

## Recommended implementation sequence

1. Approve and implement business user identifier readiness.
2. Complete the real user master and pending assignments.
3. Confirm the remaining collaboration matrix.
4. Confirm genuine task categories and owning Divisi.
5. Confirm notification and escalation recipients/channels/thresholds.
6. Add default-deny integration capability enforcement and approve registry entries.
7. Introduce one bounded n8n workflow through the canonical API.
8. Complete discovery, then design the ERP adapter.
9. Complete discovery, then design the minimum BigSeller beta adapter.
10. Calibrate business reports and critical alerts against real approved data.
11. Add Meta or Shopee only where supported and justified.
12. Consider Hermes only after canonical inputs, authorization, and structured output validation are stable.
