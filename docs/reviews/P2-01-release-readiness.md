# P2-01 Independent Release-Readiness Review

## 1. Executive Summary
This independent review evaluated the P2-01 (Runtime Settings + OWNER Actor Redesign) milestone. The implementation correctly implements an atomic, optimistic-concurrency runtime settings mechanism for `business_time_zone`, `reminder_scheduler_interval_seconds`, and `critical_alert_policy`. The OWNER actor redesign successfully unbinds the business operations from a singleton model and strictly enforces session-based actor resolution, rejecting shared-key fallback logic for mutations.

## 2. Blocking Findings
*None. The implementation successfully fulfills the ADR contracts without logical or structural flaws.*

## 3. Non-blocking Findings

### UI Capability Flags Map to Correct Endpoints
- **Severity:** NOTE
- **File:** `public/settings.js`
- **Observed:** `state.canEditRuntime` and `state.canDesignate` rely on separate probe queries (`/api/reports/task-status` and `/api/admin/users/authority-summary`) instead of standard role tokens.
- **Expected:** While slightly unconventional, this securely evaluates the effective runtime permissions of the session, gracefully falling back to read-only mode if the active user is an OWNER but lacks SYSTEM_ADMIN.
- **Impact:** Correct degradation of the UI.
- **Minimal Fix:** None required.

### No Duplicate Timer on Scheduler Reload
- **Severity:** NOTE
- **File:** `src/services/reminder-scheduler.service.ts` / `tests/settings/runtime-settings.test.ts` (S-11)
- **Observed:** `scheduler.updateIntervalMs` safely replaces the active interval without leaking orphaned timers, and honors teardown on `stop()`.
- **Expected:** Hot-reloads must not overlap or execute twice.
- **Impact:** Process integrity is maintained.
- **Minimal Fix:** None required.

## 4. Test-quality Gaps

### Missing Database Proof for SETTINGS_UNCHANGED No-Op
- **Severity:** LOW
- **File:** `tests/settings/runtime-settings-database.test.ts` / `tests/settings/runtime-settings.test.ts`
- **Observed:** Test `S-08` ("does not reload after a rejected unchanged update") uses a mocked `Repository` in TS (`vi.fn().mockRejectedValue(...)`) to simulate the DB logic. The `update_instance_runtime_settings` PL/pgSQL function correctly implements `raise exception 'SETTINGS_UNCHANGED'`, but this trigger is never exercised against the real `DisposablePostgresDatabase`.
- **Expected:** The `runtime-settings-database.test.ts` suite should include an execution of identical `update_instance_runtime_settings` inputs sequentially to prove the DB halts and rolls back before emitting an audit row.
- **Impact:** Minor gap in PL/pgSQL runtime coverage.
- **Minimal Fix:** Add a test block to `runtime-settings-database.test.ts` asserting that an identical back-to-back update throws `SETTINGS_UNCHANGED`.

**(Note on positive Test Quality):** Unlike P2-09, P2-01 possesses *excellent* real concurrency testing. Test `O-11` uses `Promise.all` against the `DisposablePostgresDatabase` to execute parallel updates and verifications, genuinely proving the `pg_advisory_xact_lock(hashtextextended('sotoayam_business_actor_invariant', 0))` invariant correctly blocks and serializes race conditions.

## 5. Migration/Upgrade Assessment
- **Migration #21 (`202609150001`):** Safe, forward-only, and fully backward-compatible.
- **RLS Boundaries:** `instance_settings` correctly denies all anon/authenticated access, explicitly granting only `service_role` execute capability via the `get_` / `set_` RPC functions.
- **Upgrade Path:** The backfill idempotent loop handles missing, singleton, and duplicate OWNER configurations cleanly, assigning the `business_actor_user_id` only when one unambiguous OWNER exists (O-12). First-admin bootstrap compatibility remains perfectly intact.

## 6. Verdict
**READY**

## 7. Ordered Next Actions
1. **Optional:** Backfill test `S-08` in `runtime-settings-database.test.ts` to prove identical payload rejection in the database layer.
2. **Commit & Push:** The P2-01 branch is fully validated and ready for integration.

