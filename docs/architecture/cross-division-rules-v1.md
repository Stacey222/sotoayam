# Cross-Divisi Rules v1

## Policy semantics

- All unspecified source/target/scope combinations are **DENY**.
- A rule applies to task creation/assignment, not to unrestricted reporting or data access.
- `requires_approval=true` keeps the proposed task non-executable until a valid approver accepts it.
- Rule changes are IT-only and audited.
- Source and target use stable `divisions.code`; renaming display text does not change rules.
- `scope_code` is a narrow business capability such as `CONTENT_REQUEST`, not free-form spreadsheet input.

## Confirmed baseline

The following are confirmed requirements, independent of individual matrix rows:

| Policy | State |
|---|---|
| Cross-Divisi collaboration is required | Confirmed |
| Requesting and owner Divisi must be distinct concepts | Confirmed |
| Requesting Divisi retains appropriate progress visibility | Confirmed |
| IT controls rules dynamically | Confirmed |
| All-to-all assignment is forbidden | Confirmed |
| Rules support allow, deny, and approval | Confirmed |
| Missing rule defaults to deny | Recommended security baseline |

The ONPAGE_B2C-to-CONTENT_CREATOR workflow is the only concrete end-to-end example stated as required. Approval policy was not confirmed, so v1 uses a conservative approval requirement until business owners approve a lower-friction rule.

## Matrix v1

| Source Divisi | Target Divisi | Allowed | Requires approval | Permitted task scope | Status | Reason |
|---|---|---:|---:|---|---|---|
| `ONPAGE_B2C` | `CONTENT_CREATOR` | yes | yes | `CONTENT_REQUEST` | **CONFIRMED relationship; PROPOSED approval setting** | On Page/B2C requests content production while Content Creator owns execution. |
| `DIGITAL_MARKETING` | `CONTENT_CREATOR` | yes | yes | `CAMPAIGN_CONTENT_REQUEST` | **PROPOSED** | Campaign work commonly needs content, but the prompt labels this only as a candidate. |
| `CONTENT_CREATOR` | `ONPAGE_B2C` | yes | yes | `PUBLISHING_HANDOFF` | **PROPOSED** | Supports explicit handoff of ready assets without granting general B2C access. |
| `PURCHASING` | `CONTENT_CREATOR` | yes | yes | `PRODUCT_SAMPLE_DEPENDENCY` | **PROPOSED** | The confirmed task-relationship example requires a sample task that can block content production. |
| `SALES_GROSIR` | `GUDANG` | yes | yes | `FULFILMENT_INVESTIGATION` | **PROPOSED** | Narrow operational investigation candidate; not general warehouse assignment. |
| `GUDANG` | `PURCHASING` | yes | yes | `REPLENISHMENT_REVIEW` | **PROPOSED** | Allows stock concerns to request purchasing review; ERP remains source of truth. |
| Any other pair | Any other pair | no | n/a | none | **DEFAULT DENY** | Prevents speculative unrestricted collaboration. |

No proposed row should be seeded as active without IT/business approval. The first implementation may seed only the confirmed relationship in inactive or approval-required state.

## Evaluation algorithm

```text
1. Verify active user and TASK_CREATE permission.
2. If source == target, apply same-Divisi policy; no collaboration rule needed.
3. Verify source equals caller's authorized requesting Divisi.
4. Find one active rule matching source, target, and scope.
5. If none or DENY, reject with TASK-ASSIGN-001.
6. If ALLOW + approval, create DRAFT plus pending task approval.
7. If ALLOW without approval, create OPEN (or DRAFT if user requested preview).
8. Record task provenance and audit decision/rule ID.
```

CSV and AI-assisted inputs pass through the same evaluator after parsing/preview. Neither a spreadsheet nor an AI proposal may override source Divisi, target Divisi, or rule scope.

## Open business decisions

These do not block additive foundation tables, but they block activating specific rules:

1. Which role/permission approves each scope: target ADMIN, requesting ADMIN, IT, or OWNER?
2. Can approval be waived for repeat low-risk scopes?
3. Should source Divisi see all activity/evidence or only a safe progress projection?
4. Which proposed relationships are operationally real and what service-level expectations apply?
