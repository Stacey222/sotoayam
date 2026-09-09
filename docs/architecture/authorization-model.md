# Authorization Model

## Decision model

Authentication and authorization are separate. Human administrators authenticate with their bootstrap email/password and an opaque server-side session. Only SHA-256 token hashes are stored; the browser carries the raw session token in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie and supplies the session-bound CSRF token for mutations.

`resolveAdminPrincipal` first validates the session against database time and current user activation, with no cache window. It then temporarily permits `ADMIN_API_KEY` only when the Stage A compatibility fallback is enabled. The fallback cannot represent a person, retains the existing singleton actor behavior, and is logged and audited once per process. Session principals resolve the exact authenticated `user_id`, so multiple active `SYSTEM_ADMIN` users do not invoke the singleton path.

Login throttling deliberately uses two non-overlapping keys after credential lookup. Known-email failures (`BAD_PASSWORD` or `INACTIVE_USER`) are counted per account: five consecutive failures within 15 minutes close that account gate, and a successful login resets the consecutive sequence. Unknown-email failures do not store the submitted email and are counted only by client IP: 50 `UNKNOWN_EMAIL` attempts within 15 minutes close that IP gate. Unknown-email IP traffic never closes a known account's gate, including when multiple clients share the application-visible proxy address.

Every protected decision should evaluate:

```text
active authenticated user
AND explicit permission from the user's one active business Role
AND resource scope (own / home Divisi / cross-Divisi)
AND active collaboration rule when creating cross-Divisi work
AND SYSTEM_ADMIN authority in an active authority-capable Divisi only for protected governance operations
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

| Action | STAFF | ADMIN | OWNER | Authority-capable Divisi + SYSTEM_ADMIN |
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
| View technical monitoring | No | No | Business-level automation status only | Allow with `TECH_MONITOR_VIEW`; authority alone adds no report scope |
| Manage users | No | No | No | Allow: capability + Authority + `USER_MANAGE` |
| Manage Divisi | No | No | No | Allow: capability + Authority + `DIVISION_MANAGE` |
| Manage roles | No | No | No | Allow: capability + Authority + `ROLE_MANAGE`; permission grants require stronger check |
| Manage role permissions | No | No | No | Allow: capability + Authority + `PERMISSION_MANAGE` |
| Manage notification routing | No | No | No | Allow: capability + Authority + `ROUTING_MANAGE` |
| Manage alert thresholds | No | No | No | Allow: capability + Authority + `THRESHOLD_MANAGE` |
| Manage collaboration rules | No | No | No | Allow: capability + Authority + `COLLABORATION_RULE_MANAGE` |
| Grant/revoke `SYSTEM_ADMIN` | No | No | No | Authority + `SYSTEM_AUTHORITY_MANAGE`; mandatory audit and continuity invariant |

## Role baselines

These are seed proposals; each becomes explicit `role_permissions` rows and is reviewable by IT.

- **STAFF**: own-task view, task create, assigned-task update/complete, notes/evidence, optionally import.
- **ADMIN**: STAFF plus Divisi task/report visibility and scoped assignment. It receives no technical administration permissions.
- **OWNER**: cross-Divisi registered business reports, material alert/approval capabilities, and business-level automation status. It does not inherit every route or technical log.
- **Authority-capable Divisi**: the guarded `divisions.grants_system_authority` capability makes active users in that customer-owned division eligible for `SYSTEM_ADMIN`; no literal Divisi code or name is authoritative.
- **SYSTEM_ADMIN assignment**: enables protected governance checks only when the user and authority-capable division are active, and grants no implicit business data scope.

## Resource rules

### Tasks

- Requesting Divisi can view status/activity needed to track its request.
- Owner Divisi controls execution and assignment under its own scoped permissions.
- Assignee can update work fields but cannot rewrite requesting/owner Divisi or source provenance.
- Terminal-state changes must create an activity and audit record in the same transaction.
- Cross-Divisi creation requires an active matching collaboration rule; missing rule means deny.

### Reports

- A report catalog entry declares its required permission and allowed scope. The generic `TASK_STATUS` report accepts optional division, task-category, status, and time-window filters.
- Authorization occurs before the report handler queries a source.
- Output includes source and freshness; stale output is labeled.
- OWNER accesses registered business reports through explicit `report.view_division` or `report.view_cross_division` permission, never arbitrary SQL or raw provider APIs.
- The historical `AFFILIATE_TASK_STATUS` alias is compatibility-only: it is absent for explicitly fresh installations and retained for legacy or unknown provenance.

### Configuration

- Only an active SYSTEM_ADMIN in an active authority-capable Divisi, with the action permission where applicable, may change users, taxonomy, routing, thresholds, or collaboration rules.
- Division capability changes run through owner-defined guarded database functions. Direct service-role writes and removal of the last post-bootstrap capable division are rejected.
- Permission-model changes and system-authority transfer additionally require `SYSTEM_ADMIN`.
- Every mutation records actor, target, before/after, source, and time.

## System authority continuity

A service transaction should enforce:

1. grant target is an active authenticated user;
2. actor has active `SYSTEM_ADMIN`, belongs to an active authority-capable Divisi, and has `SYSTEM_AUTHORITY_MANAGE`;
3. revocation cannot leave zero active system administrators unless an explicit, separately controlled emergency procedure exists;
4. grant and revocation are audited atomically;
5. authority is never inferred from Telegram Chat ID, role name, or personal identity.

## RLS posture

Current backend uses a server credential that bypasses RLS. Near-term authorization therefore lives in application services, with repository methods receiving an authorization context or already-scoped query specification.

Future authenticated browser access may add RLS as defense in depth, but no public policy should be added. Service-role credentials remain server-only. Application tests must remain the primary proof that Divisi isolation works.

The browser session store uses deny-all RLS and service-only `SECURITY DEFINER` functions. Deactivation, revocation, absolute expiry, and idle expiry are evaluated on every request. `OWNER` report actor redesign remains separate: a session user must first pass the active `SYSTEM_ADMIN` guard, while the existing singleton OWNER business actor remains unchanged until P2-01.
