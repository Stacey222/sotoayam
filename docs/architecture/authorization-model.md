# Authorization Model

## Decision model

Authentication and authorization are separate. Human HTTP requests use a verified Supabase Bearer session mapped through server-controlled `app_metadata.gwens_user_id`. The shared `ADMIN_API_KEY` remains only as a temporary secondary boundary; it cannot represent a person.

Every protected decision should evaluate:

```text
active authenticated user
AND explicit permission from the user's one active business Role
AND resource scope (own / home Divisi / cross-Divisi)
AND active collaboration rule when creating cross-Divisi work
AND SYSTEM_ADMIN authority only for protected governance operations
```

`OWNER`, `ADMIN`, and `SYSTEM_ADMIN` are not aliases for “allow everything.” Service-role access to PostgreSQL also does not authorize the caller; backend services must enforce these rules before querying or mutating data.

## Scope vocabulary

- **OWN**: the user is creator or assignee, as defined by the action.
- **HOME_DIVISION**: the resource owner/requester matches `users.home_division_id` under the action policy.
- **REQUESTING_DIVISION**: requester Divisi may view the progress of work it requested.
- **CROSS_DIVISION**: explicit permission or OWNER report capability allows broader business visibility.
- **TECHNICAL**: system/integration metadata, not raw unrelated business reports.
- **GOVERNANCE**: authority grant/revoke, permission model, and protected configuration.

## Recommended permission families

```text
TASK_VIEW_OWN
TASK_VIEW_DIVISION
TASK_VIEW_REQUESTED
TASK_VIEW_CROSS_DIVISION
TASK_CREATE
TASK_ASSIGN
TASK_UPDATE_ASSIGNED
TASK_COMPLETE_ASSIGNED
TASK_IMPORT

REPORT_VIEW_DIVISION
REPORT_VIEW_CROSS_DIVISION
REPORT_VIEW_OWNER

TECH_MONITOR_VIEW
INCIDENT_MANAGE

USER_MANAGE
DIVISION_MANAGE
ROLE_MANAGE
PERMISSION_MANAGE
ROUTING_MANAGE
THRESHOLD_MANAGE
COLLABORATION_RULE_MANAGE
SYSTEM_AUTHORITY_MANAGE
```

Codes are explicit capabilities. Creating a role with no role-permission rows grants no access.

## Authorization matrix

Legend: **Allow** means the listed permission and scope conditions must pass; **No** means the role alone cannot perform it; **Rule** adds collaboration policy; **Authority** requires active `SYSTEM_ADMIN` assignment.

| Action | STAFF | ADMIN | OWNER | IT + SYSTEM_ADMIN |
|---|---|---|---|---|
| View own assigned/created tasks | Allow: `TASK_VIEW_OWN` | Allow | Allow if involved, otherwise role permission | Allow if involved; authority alone adds nothing |
| Create same-Divisi task | Allow: `TASK_CREATE`, home scope | Allow: home scope | Allow only with explicit task permission | Allow only with explicit task permission |
| Create cross-Divisi task | Allow + Rule + optional approval | Allow + Rule + optional approval | Allow + Rule; no automatic bypass | Allow + Rule; authority does not bypass business rule |
| Update assigned task | Allow: assigned user | Allow if assigned or home-owner policy permits | Only if assigned/explicit permission | Same business rule as other users |
| Complete assigned task | Allow: assigned user | Allow: assigned user or scoped override permission | No automatic override | No automatic override |
| View all home-Divisi tasks | No unless explicitly granted | Allow: `TASK_VIEW_DIVISION`, home scope | Allow with cross-Divisi business permission | IT authority does not expose business data |
| View requesting-Divisi progress | Allow: `TASK_VIEW_REQUESTED`, requester scope | Allow: requester home Divisi | Allow with cross-Divisi permission | Only with business permission |
| View another Divisi business report | No | No | Allow: `REPORT_VIEW_OWNER`/cross-Divisi | No by technical authority alone |
| View Owner reports | No | No unless separately granted | Allow: registered report capability | No by technical authority alone |
| View technical monitoring | No | No | Business-level automation status only | Allow: IT home Divisi + `TECH_MONITOR_VIEW` |
| Manage users | No | No | No | Allow: IT + `USER_MANAGE` |
| Manage Divisi | No | No | No | Allow: IT + `DIVISION_MANAGE` |
| Manage roles | No | No | No | Allow: IT + `ROLE_MANAGE`; permission grants require stronger check |
| Manage role permissions | No | No | No | Allow: IT + `PERMISSION_MANAGE` + Authority |
| Manage notification routing | No | No | No | Allow: IT + `ROUTING_MANAGE` |
| Manage alert thresholds | No | No | No | Allow: IT + `THRESHOLD_MANAGE` |
| Manage collaboration rules | No | No | No | Allow: IT + `COLLABORATION_RULE_MANAGE` |
| Grant/revoke `SYSTEM_ADMIN` | No | No | No | Authority + `SYSTEM_AUTHORITY_MANAGE`; mandatory audit and continuity invariant |

## Role baselines

These are seed proposals; each becomes explicit `role_permissions` rows and is reviewable by IT.

- **STAFF**: own-task view, task create, assigned-task update/complete, notes/evidence, optionally import.
- **ADMIN**: STAFF plus Divisi task/report visibility and scoped assignment. It receives no technical administration permissions.
- **OWNER**: cross-Divisi registered business reports, material alert/approval capabilities, and business-level automation status. It does not inherit every route or technical log.
- **IT role**: technical monitoring and explicitly granted configuration permissions. Being in Divisi IT alone grants nothing.
- **SYSTEM_ADMIN assignment**: enables protected governance checks but no implicit business data scope.

## Resource rules

### Tasks

- Requesting Divisi can view status/activity needed to track its request.
- Owner Divisi controls execution and assignment under its own scoped permissions.
- Assignee can update work fields but cannot rewrite requesting/owner Divisi or source provenance.
- Terminal-state changes must create an activity and audit record in the same transaction.
- Cross-Divisi creation requires an active matching collaboration rule; missing rule means deny.

### Reports

- A report catalog entry declares its required permission and allowed scope.
- Authorization occurs before the report handler queries a source.
- Output includes source and freshness; stale output is labeled.
- OWNER accesses registered business reports, never arbitrary SQL or raw provider APIs.

### Configuration

- Only an active IT user with the action permission may change users, routing, thresholds, or collaboration rules.
- Permission-model changes and system-authority transfer additionally require `SYSTEM_ADMIN`.
- Every mutation records actor, target, before/after, source, and time.

## System authority continuity

A service transaction should enforce:

1. grant target is an active authenticated user;
2. actor has active `SYSTEM_ADMIN` plus `SYSTEM_AUTHORITY_MANAGE`;
3. revocation cannot leave zero active system administrators unless an explicit, separately controlled emergency procedure exists;
4. grant and revocation are audited atomically;
5. authority is never inferred from Telegram Chat ID, role name, or personal identity.

## RLS posture

Current backend uses a server credential that bypasses RLS. Near-term authorization therefore lives in application services, with repository methods receiving an authorization context or already-scoped query specification.

Future authenticated browser access may add RLS as defense in depth, but no public policy should be added. Service-role credentials remain server-only. Application tests must remain the primary proof that Divisi isolation works.
