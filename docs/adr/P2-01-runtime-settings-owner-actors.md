# ADR P2-01 - Runtime Settings and OWNER Actor Redesign

## Status

Implemented.

This document defines the implemented P2-01 milestone. Migration #21 is the sole additive schema change; migrations #1-20 remain immutable.

## 1. Context

Repository governance assigns two related Phase 2 gaps to P2-01:

1. legitimate customer settings need a supported runtime surface instead of source or deployment-file edits; and
2. HTTP OWNER operations must stop resolving an unrelated singleton OWNER and instead use the authenticated human actor.

The current application reads every process setting from `src/config/env.ts` at startup. The legitimate business values identified by the PRD are the business timezone, scheduler cadence, and critical-alert thresholds. Taxonomy is already data-backed through P0-14. Message catalog extraction is P2-02 and notification-preference normalization is P2-03.

P1-01 introduced real session principals but deliberately retained singleton OWNER resolution for reports and critical alerts. P2-00 and P2-09 now provide trustworthy SYSTEM_ADMIN actors and transactional protection for the last effective SYSTEM_ADMIN. P2-01 must close the OWNER gap without weakening those boundaries.

## 2. Scope

P2-01 implements:

- a typed singleton `instance_settings` record;
- runtime management of exactly three business settings;
- immediate single-process reload of those settings;
- an explicit `business_actor_user_id` replacing implicit exactly-one-OWNER lookup for compatibility paths;
- session-derived OWNER actors for HTTP reports, critical alerts, and runtime-setting changes;
- a guarded designated-business-actor invariant;
- a small Indonesian settings view in the existing vanilla/Tabler dashboard; and
- audit, schema, route, UI, and disposable-PostgreSQL tests.

P2-01 does not implement custom roles, permission editing, approval workflow, notification preferences, message customization, white-labeling, multi-tenancy, Redis, another worker, or deployment control from the browser.

## 3. Current capabilities and gaps

### Existing foundations to reuse

- `AppConfig` validates all deployment input once at startup.
- `BUSINESS_TIME_ZONE`, `REMINDER_SCHEDULER_INTERVAL_SECONDS`, and `CRITICAL_ALERT_POLICY_JSON` already have product defaults and validation.
- `ReportingService`, `ReminderSchedulerService`, `CriticalAlertEvaluatorService`, and `CriticalAlertService` consume those values.
- `OWNER` is a reserved, active role with business permissions; it is not a SYSTEM_ADMIN assignment.
- P1-01 sessions identify one real normalized user and enforce password-change and CSRF rules.
- P2-00 defines effective SYSTEM_ADMIN and its compatibility advisory lock.
- P2-09 can create a login-capable user with the OWNER role and safely modify user access.
- `audit_logs` is append-only and supports real `USER` attribution.

### Gaps

- Every setting is environment-only and captured by constructed services.
- Changing a business value requires editing deployment configuration and restarting.
- HTTP report/alert routes authorize the session as SYSTEM_ADMIN but execute as a separately resolved singleton OWNER.
- Two active OWNER users cause `OWNER_ACTOR_UNAVAILABLE`.
- A session user's actions can therefore be attributed to another user.
- There is no supported designation or invariant for the instance's default business actor.
- The dashboard has system health but no settings editor.

## 4. Runtime-settings boundary

### 4.1 Runtime-configurable in P2-01

Only these values are persisted and editable:

| Setting | Default source | Validation | Live consumers |
| --- | --- | --- | --- |
| `business_time_zone` | current `BUSINESS_TIME_ZONE`, default `UTC` | valid IANA timezone accepted by `Intl.DateTimeFormat`; 1-100 characters | reporting time-window calculations |
| `reminder_scheduler_interval_seconds` | current environment value, default 300 | integer 60-3600 | scheduler interval and lease duration |
| `critical_alert_policy` | current parsed policy/default | exact `overdue`, `blocked`, and `scheduler` object; integers 1-8760; warning < high < critical; stale < critical | alert evaluation and automation-health thresholds |

The API uses the current validated environment values only as a deployment baseline when no persisted override exists. Once runtime settings are saved, the complete three-setting snapshot is authoritative across restarts.

### 4.2 Remain deployment-only

The runtime API must not enumerate or mutate:

- Supabase URL, project identity, database password, access token, or service-role key;
- Telegram, internal, administrator, integration, session, or CSRF credentials;
- `HOST`, `PORT`, `TRUST_PROXY`, cookie security, session TTLs, or log level;
- `ADMIN_API_KEY_FALLBACK_ENABLED` or `INTERNAL_API_KEY_FALLBACK_ENABLED`;
- rate-limit enablement, budgets, trusted IPs, or memory bounds;
- readiness timeout/cache values;
- Telegram polling ownership, polling retry/dedupe values, or fan-out limits;
- reminder/critical-alert/Telegram worker enable flags.

Those values determine trust boundaries, process topology, network exposure, capacity protection, or worker ownership. They continue to require a reviewed deployment change and restart.

Operational taxonomy remains on its existing P0-14 endpoints. Messages remain P2-02. Notification preferences remain P2-03.

## 5. OWNER model

### 5.1 Meaning

`OWNER` remains the reserved default business-oversight role and permission bundle. It is not a second system authority. Authorization stays permission-keyed as established by P0-14: an effective OWNER actor is a normalized user who is active, belongs to an active division, holds an active role, and has the active permission required by the requested operation. Route authorization must not regress to a literal role-code check.

`SYSTEM_ADMIN` remains a separate explicit authority assignment governed by P2-00. It controls security, users, authority, integrations, and technical/customer taxonomy. It does not imply OWNER business permissions. OWNER does not imply SYSTEM_ADMIN. One user may intentionally hold both.

The OWNER role retains `report.view_cross_division`, `alert.view_critical`, `alert.acknowledge`, `approval.view`, `approval.decide`, and `automation_status.view_business`. Migration #21 adds the existing unassigned permission `threshold.manage` to OWNER so business-policy settings have an explicit permission rather than a role-name shortcut. These seven permissions are the default OWNER business permission set used by designated-actor eligibility in P2-01.

### 5.2 Session actor resolution

Add a business-actor resolver separate from `resolveAdminActor`:

- a session principal resolves its exact `adminUserId`, current normalized access, and active role permissions;
- it does not require SYSTEM_ADMIN;
- each service still checks its exact permission;
- inactive user/division/role or missing permission fails with 403;
- `resolveAdminActor` remains unchanged for all SYSTEM_ADMIN surfaces.

HTTP report and critical-alert routes use this exact session actor. They no longer call the singleton resolver for session requests. Telegram OWNER commands already resolve the exact Telegram-linked user and keep that behavior.

### 5.3 Designated business actor

`instance_settings.business_actor_user_id` is the explicit default actor for compatibility-only, non-session OWNER reads. It is not an identity substitute for authenticated requests and must never be written into audit rows as if it were the shared-key caller.

The selected user must be login-capable, must not require a password change, and must have the complete active default OWNER business permission set, including `threshold.manage`. Migration #21 backfills the field only when exactly one existing active user in the reserved OWNER role satisfies those conditions without ambiguity. Zero or multiple eligible users leave it unset for a SYSTEM_ADMIN to choose. Runtime eligibility checks use permissions, not the role-code shortcut.

Once selected, the field cannot be cleared through the product API. Replacement is an atomic forward change to another eligible OWNER.

### 5.4 ADMIN_API_KEY treatment

- Runtime-settings endpoints require a session; shared `ADMIN_API_KEY` receives `401 SESSION_REQUIRED`.
- OWNER mutations, including alert acknowledgement, require a real OWNER session; shared key receives `401 SESSION_REQUIRED`.
- To preserve the narrow Stage B read compatibility, shared key may continue to call existing GET-only report/alert routes only when `business_actor_user_id` resolves to an effective OWNER with the required permission.
- If no designated actor is available, those compatibility reads fail closed with `503 OWNER_ACTOR_UNAVAILABLE`.
- Logs identify the principal as `shared-api-key`; no audit row claims the designated OWNER performed the read.
- No new fallback is introduced and fallback defaults remain unchanged.

## 6. Authorization matrix

| Operation | Effective OWNER session | Effective SYSTEM_ADMIN session | Both | Shared key |
| --- | :---: | :---: | :---: | :---: |
| GET runtime settings | Yes | Yes | Yes | No |
| Update runtime settings | Yes, with `threshold.manage` | No, unless also OWNER | Yes | No |
| Select/replace designated business actor | No, unless also SYSTEM_ADMIN | Yes | Yes | No |
| Read reports/critical alerts/automation status | Yes, per existing permission | No, unless also OWNER | Yes | GET-only compatibility via designated actor |
| Acknowledge critical alert | Yes, with `alert.acknowledge` | No, unless also OWNER | Yes | No |
| P2-09 user/access management | No, unless also SYSTEM_ADMIN | Yes | Yes | No |
| Grant/revoke SYSTEM_ADMIN | No, unless also SYSTEM_ADMIN | Yes | Yes | No |
| Deployment/security configuration | No | No | No | No |

P2-01 is the narrow role-onboarding exception to D-007's temporary all-admin-routes-require-SYSTEM_ADMIN rule. Only OWNER/settings groups change. P2-00 and P2-09 remain session-only effective-SYSTEM_ADMIN surfaces.

## 7. API contract

All endpoints use `defineAdminRoutes`, existing envelopes, P1-03 structural policy, P1-01 cookies, and CSRF. The new route group is added to the admin authorization and rate-limit manifests.

### 7.1 Read settings

`GET /api/admin/settings`

Requires a session actor who is either effective SYSTEM_ADMIN or effective OWNER. Response uses `Cache-Control: no-store`:

```json
{
  "success": true,
  "data": {
    "version": 0,
    "runtime": {
      "business_time_zone": "UTC",
      "reminder_scheduler_interval_seconds": 300,
      "critical_alert_policy": {
        "overdue": { "warningHours": 1, "highHours": 24, "criticalHours": 72 },
        "blocked": { "warningHours": 4, "highHours": 24, "criticalHours": 72 },
        "scheduler": { "staleMinutes": 15, "criticalMinutes": 60 }
      }
    },
    "source": "DEPLOYMENT_DEFAULT",
    "business_actor": null,
    "updated_at": null
  }
}
```

`source` is exactly `DEPLOYMENT_DEFAULT` or `RUNTIME`. `business_actor`, when configured, contains only `id` and `display_name`. The DTO is an allowlist and never spreads a database/config object.

### 7.2 Update runtime settings

`PATCH /api/admin/settings/runtime`

Requires an effective OWNER session with `threshold.manage`. Body is a full replacement to avoid partially composed policy state:

```json
{
  "expected_version": 0,
  "business_time_zone": "Asia/Jakarta",
  "reminder_scheduler_interval_seconds": 300,
  "critical_alert_policy": {
    "overdue": { "warningHours": 1, "highHours": 24, "criticalHours": 72 },
    "blocked": { "warningHours": 4, "highHours": 24, "criticalHours": 72 },
    "scheduler": { "staleMinutes": 15, "criticalMinutes": 60 }
  },
  "reason": "Menyesuaikan kebijakan operasional"
}
```

Unknown or missing fields fail with `400 VALIDATION_ERROR`. `reason` is trimmed and 1-500 characters. A stale version returns `409 SETTINGS_VERSION_CONFLICT`; an identical snapshot returns `409 SETTINGS_UNCHANGED`. The successful response is the GET DTO and uses `Cache-Control: no-store`.

### 7.3 Select designated business actor

`PATCH /api/admin/settings/business-actor`

Requires a session-authenticated effective SYSTEM_ADMIN:

```json
{
  "expected_version": 1,
  "user_id": 42,
  "reason": "Menetapkan penanggung jawab bisnis utama"
}
```

The target must satisfy the designated-actor eligibility rule. Invalid targets return `409 BUSINESS_ACTOR_INELIGIBLE`, stale writes return `409 SETTINGS_VERSION_CONFLICT`, and selecting the current value returns `409 SETTINGS_UNCHANGED`.

## 8. Persistence and migration plan

Implementation adds exactly one forward migration, repository migration #21. Migrations #1-20 remain byte-identical.

Create one deny-all-RLS singleton table:

```sql
create table public.instance_settings (
  singleton_key boolean primary key default true check (singleton_key),
  business_time_zone text,
  reminder_scheduler_interval_seconds integer,
  critical_alert_policy jsonb,
  business_actor_user_id bigint references public.users(id) on delete restrict,
  version bigint not null default 0 check (version >= 0),
  updated_at timestamptz,
  updated_by_user_id bigint references public.users(id),
  check (
    (business_time_zone is null and reminder_scheduler_interval_seconds is null and critical_alert_policy is null)
    or
    (business_time_zone is not null and reminder_scheduler_interval_seconds is not null and critical_alert_policy is not null)
  ),
  check (reminder_scheduler_interval_seconds is null or reminder_scheduler_interval_seconds between 60 and 3600)
);
```

The migration inserts the singleton with nullable runtime fields. Null means use the validated deployment baseline. It may backfill `business_actor_user_id` only for one unambiguous eligible OWNER.

The migration also:

- defines strict JSON policy validation at the database boundary;
- grants `threshold.manage` to OWNER idempotently;
- provides service-role-only SECURITY DEFINER read/update/designation RPCs with fixed search paths;
- revokes table/function access from `public`, `anon`, and `authenticated`;
- uses optimistic `version` checks and row locking;
- introduces `sotoayam_business_actor_invariant` as a new advisory-lock key;
- uses a consistent lock order: existing `gwens_system_admin_invariant` first when needed, then the business-actor lock;
- updates current access/division RPC bodies with `CREATE OR REPLACE` so the selected business actor cannot be deactivated, moved to an inactive division, moved to a role lacking the required business permissions, or invalidated by division deactivation before a replacement is selected; and
- leaves P2-00's effective-SYSTEM_ADMIN checks and external P2-09 contracts unchanged.

The invariant is compatibility-safe: it is armed only when `business_actor_user_id` is non-null. An upgraded installation with no unambiguous OWNER remains operable for SYSTEM_ADMIN setup. After designation, every supported path preserves one eligible designated OWNER. Concurrent designation and access reduction serialize; both cannot commit an invalid result.

## 9. Runtime reload semantics

Introduce a process-local `RuntimeSettingsProvider` initialized from the environment baseline plus the persisted row before dependent services are constructed.

- Reporting reads a settings snapshot at the start of each request.
- Critical-alert evaluation and automation status read one snapshot per evaluation/request.
- Scheduler cadence update atomically replaces its interval timer after database commit; it does not interrupt an in-flight run and schedules the next run from the update time.
- Worker enable/disable state never changes through this provider.
- A successful PATCH persists first, applies the returned committed snapshot, then responds.
- Restart reloads the persisted snapshot.
- Direct out-of-band database edits are unsupported and require restart; no polling/listener is added for v1.
- There is no stale-while-error or retry loop. If settings cannot be loaded at startup, application readiness fails rather than silently inventing persisted state.

Single-process behavior is authoritative for v1. Multi-process cache invalidation is explicitly out of scope.

## 10. Audit and logging

Runtime updates write `RUNTIME_SETTINGS_UPDATED`; actor selection writes `BUSINESS_ACTOR_CHANGED`. Both use `actor_type='USER'`, the exact session user's ID, safe before/after state, reason, and source `runtime_settings_api` in the same transaction as the mutation.

Critical-alert acknowledgement continues to record the exact OWNER session user. Historical audit rows are not rewritten. Shared-key compatibility reads create no false USER audit attribution.

Structured application logs may include request ID, actor user ID, settings version, changed field names, and outcome. They must not include the complete environment, credentials, tokens, hashes, headers, raw request bodies, database URL, host identity, or secret values.

## 11. UI plan

Reuse the current vanilla ES-module architecture and local Tabler assets. Add `public/settings.js`; do not move P2-09 behavior from `public/users.js`.

The existing `Sistem` page retains liveness/readiness cards and gains a `Pengaturan runtime` card:

- timezone select/search input;
- scheduler cadence numeric input with minute guidance;
- grouped overdue, blocked, and scheduler alert thresholds;
- source badge (`Default deployment` or `Runtime`);
- last-updated metadata;
- inline validation, loading/error/403/409 states;
- confirmation and required reason before save; and
- no worker-toggle or secret/config inventory.

An effective SYSTEM_ADMIN additionally sees a `Penanggung jawab bisnis` selector populated only with safe eligible user metadata. OWNER-only users see current designation but cannot change it. An OWNER may save runtime policy; a SYSTEM_ADMIN who is not also OWNER sees the form read-only. The UI sends CSRF through the existing helper and refreshes after version conflicts.

No setting or credential is written to browser local/session storage.

## 12. Compatibility impact

- P1-01 session, password, cookie, CSRF, cooldown, and revocation behavior is unchanged.
- `resolveAdminActor` and all SYSTEM_ADMIN-protected routes remain unchanged.
- P1-03 gains one structurally declared settings route group; no limiter implementation/default changes.
- P2-00 lock name and effective-SYSTEM_ADMIN invariant remain unchanged.
- P2-09 APIs, DTOs, UI, temporary passwords, and authorization remain unchanged.
- Existing report/alert URLs and response bodies remain unchanged.
- Existing OWNER permission semantics are retained and extended only by `threshold.manage`.
- Existing environments remain valid and act as defaults until a runtime snapshot is persisted.
- First-admin bootstrap remains ADMIN + SYSTEM_ADMIN and never silently grants OWNER.
- An operator creates/grants an OWNER through P2-09, completes its password change, then designates it through settings.

## 13. Test matrix

| Ref | Acceptance test |
| --- | --- |
| S-01 | With no persisted snapshot, GET returns exactly the validated environment baseline and `DEPLOYMENT_DEFAULT`. |
| S-02 | Persisted settings override all three baseline values after restart. |
| S-03 | Timezone validation accepts a valid IANA zone and rejects unknown/control/oversized values. |
| S-04 | Scheduler cadence enforces integer 60-3600 in HTTP, service, and database paths. |
| S-05 | Alert policy rejects unknown/missing keys, non-integers, out-of-range values, and invalid ordering. |
| S-06 | Runtime update is atomic and writes one correctly attributed sanitized audit row. |
| S-07 | Optimistic concurrency rejects a stale version and preserves the winning snapshot. |
| S-08 | Identical update returns `SETTINGS_UNCHANGED` without an audit row or reload. |
| S-09 | Reporting uses the new timezone on the next request without restart. |
| S-10 | Alert evaluator and automation health use the new policy on their next operation without restart. |
| S-11 | Scheduler cadence replaces the timer, does not overlap/invalidate an in-flight run, and leaves no referenced timer after close. |
| S-12 | Worker enable flags and every deployment-only setting are absent from request/response DTOs and cannot be submitted. |
| O-01 | An OWNER session resolves its own user and can read owner reports without SYSTEM_ADMIN. |
| O-02 | Two OWNER sessions operate independently; no singleton ambiguity occurs and each mutation audit uses its own ID. |
| O-03 | SYSTEM_ADMIN without OWNER permission cannot read OWNER data or update runtime policy. |
| O-04 | OWNER without SYSTEM_ADMIN cannot access P2-09, taxonomy, integration administration, or authority mutation. |
| O-05 | A dual OWNER+SYSTEM_ADMIN user can use both boundaries without identity substitution. |
| O-06 | Shared key is rejected from settings and OWNER mutations, including alert acknowledgement. |
| O-07 | Shared-key GET compatibility uses only the designated actor, fails closed when unset/ineligible, and creates no USER audit attribution. |
| O-08 | SYSTEM_ADMIN can designate an eligible OWNER; OWNER-only and shared-key callers cannot. |
| O-09 | An inactive user/division/role, missing required OWNER business permission, missing credential, or password-change-required user is ineligible for designation. |
| O-10 | Deactivation, role change, division move, and division deactivation cannot invalidate the designated actor until replacement. |
| O-11 | Concurrent actor replacement and destructive access change serialize and preserve one eligible designated actor. |
| O-12 | First-admin bootstrap still creates ADMIN + SYSTEM_ADMIN, no OWNER, and leaves designation safely unset. |
| A-01 | GET is admin-read; both PATCH routes are admin-write and CSRF-protected; the security/rate-limit manifests contain the new group. |
| A-02 | `password_change_required` blocks settings/OWNER routes while session/password/logout remain usable. |
| A-03 | Responses and logs contain no environment dump, secret, token, hash, raw Telegram ID, or forbidden internal detail. |
| UI-01 | System/settings UI enforces capability-specific read/edit states and handles loading, validation, 401/403/409, confirmation, and mobile layout. |
| M-01 | Exactly 21 migrations apply twice on disposable PostgreSQL; hashes for migrations #1-20 remain unchanged; governance/RLS/grants pass. |
| R-01 | Existing P1-01, P1-03, P2-00, P2-09, reports, alerts, bootstrap, readiness, and UI suites remain green. |

Runtime database proof is required for S-02, S-06, S-07, O-08 through O-12, and M-01. SQL text inspection alone is supplemental, not acceptance evidence.

## 14. Risks and implementation stop conditions

- The business timezone currently affects reporting only. P2-01 must not claim broader calendar behavior without another consumer.
- Updating alert thresholds may change existing alert severities on the next evaluation; this is intended and audited, but it does not rewrite historical alerts immediately.
- Scheduler cadence reload is local to one process. A future multi-process topology requires distributed invalidation and is outside v1.
- Stage B shared-key GET compatibility is intentionally narrower than human sessions and must be removed with the broader fallback retirement.
- The designated-actor invariant is not armed until an eligible actor is selected on an ambiguous/empty upgrade. UI and GET must show that state clearly.

Implementation must stop for architecture review if it requires a second migration, a historical migration edit, changing P2-09 contracts, granting OWNER system authority, letting SYSTEM_ADMIN imply business permissions, exposing deployment secrets, or adding another runtime process/dependency.

## 15. Implementation order

1. Add migration #21 and disposable database tests.
2. Add typed settings repository/provider/service and tests.
3. Add the settings route group and structural authorization tests.
4. Pilot exact session OWNER resolution on reports; verify unchanged response contracts.
5. Migrate critical-alert/automation-status routes and retain exact Telegram actor resolution.
6. Add scheduler/report/alert live-reload wiring.
7. Add `public/settings.js` and the System-page controls.
8. Run focused and full validation, clean migrations, governance checks, historical hashes, secret scan, and diff check.
