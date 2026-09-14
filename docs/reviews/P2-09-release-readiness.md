# P2-00 & P2-09 Independent Release-Readiness Review

## Executive Summary
This independent review evaluated the uncommitted implementation of P2-00 (SYSTEM_ADMIN invariant hardening) and P2-09 (Admin & User Management Foundation). 

The application architecture, authorization boundaries, concurrent transaction locking, and database integrity are robust and correctly implemented. The usage of PL/pgSQL atomic functions, `hashtextextended` advisory locks, and dynamic session capability evaluation inside `resolveAdminActor` ensures that all authorization and concurrency contracts are honored at runtime.

However, the test suite (`U-01..U-19`) contains significant testing gaps characterized by over-reliance on mocks and regex-based SQL file parsing instead of executing real database integration tests. The code is ready, but the test suite provides false confidence.

## Blocking Findings

### 1. False Confidence in Concurrency and Transaction Tests
- **Severity:** BLOCKER
- **File:** `tests/user-management/admin-user-management-foundation.test.ts`
- **Observed:** Tests `U-09`, `U-11`, `U-13`, `U-16`, and `U-17` do not interact with the database. They read the raw SQL migration file using `readFile` and use string-matching (`expect(sql).toContain(...)`) to assert the presence of transaction blocks, locks, and audits.
- **Expected:** These tests must execute the actual operations against the disposable PostgreSQL test database and assert the resulting state and concurrency boundaries (e.g. firing parallel `updateAccess` queries to trigger the `pg_advisory_xact_lock`).
- **Impact:** Complete lack of runtime verification for the P2-00 advisory lock and P2-09 atomic user creation/revocation. If the SQL has a runtime logical error, the tests will still pass.
- **Minimal Fix:** Rewrite `U-09`, `U-11`, `U-13`, `U-16`, and `U-17` to invoke the real `UserManagementService` hooked up to a real PostgreSQL database, executing concurrent operations where necessary and verifying the final database state.

### 2. Missing Integration Coverage for Data Integrity Constraints
- **Severity:** BLOCKER
- **File:** `tests/user-management/admin-user-management-foundation.test.ts`
- **Observed:** `U-08` tests email duplication/normalization by mocking the repository (`const createAdministrator = vi.fn()`) instead of verifying that the database throws a unique constraint error (`23505`) which `databaseError` successfully maps to `409 EMAIL_ALREADY_IN_USE`. 
- **Expected:** The test must interact with the real database to prove the `admin_credentials_email_uidx` constraint functions and the backend correctly parses the resulting Postgres error.
- **Impact:** Risk of regression in how `databaseError` parses the PostgreSQL diagnostic if the constraint name or database error code ever changes.
- **Minimal Fix:** Rewrite `U-08` to insert a user into the real database, and then intentionally attempt to create a second user with a duplicate (case-insensitive) email to verify the `409` HTTP response.

## Non-Blocking Findings & Architecture Notes

### 1. Safe `password_change_required` Lifecycle
- **Severity:** NOTE
- **Observed:** `password_change_required` correctly defaults to `false` in Migration #20, ensuring backwards compatibility for `bootstrap_first_admin`. The flag is verified inside `defineAdminRoutes` (via `resolveAdminPrincipal`), effectively blocking all restricted admin routes. The `/password` route safely bypasses this block as it is not encapsulated by `defineAdminRoutes`.
- **Verdict:** Correctly implemented.

### 2. P2-00 Invariant Safety
- **Severity:** NOTE
- **Observed:** `pg_advisory_xact_lock(hashtextextended('gwens_system_admin_invariant', 0))` provides a bulletproof transactional lock that correctly blocks concurrent changes across functions and triggers until the surrounding transaction commits.
- **Verdict:** Correctly implemented.

### 3. Session Revocation upon Deactivation
- **Severity:** NOTE
- **Observed:** Demoted/inactive users lose their administrative power immediately upon the next request. `hasActiveSystemAdminAuthority` correctly performs a live query on every protected route invocation, rendering active sessions powerless if the underlying assignment is revoked. Deactivating a user explicitly revokes sessions atomically via `update public.admin_sessions set revoked_at = now()`.
- **Verdict:** Correctly implemented.

### 4. Temporary Password Security
- **Severity:** NOTE
- **Observed:** `generateTemporaryPassword` correctly issues cryptographically secure temporary passwords. Audit logs only persist boolean flags (`password_change_required: true`), and the database only stores the SCrypt hash. The plaintext password is never logged.
- **Verdict:** Correctly implemented.

## Migration Verification
- **Migrations:** #19 (`202609130001`) and #20 (`202609140001`) are sound.
- **Upgrade Path:** Backward compatible. Existing active sessions remain valid. The first administrator bootstrap continues to work flawlessly.
- **Least Privilege:** Functions use `SECURITY DEFINER`, `SET search_path = ''`, and correctly restrict public access via `revoke all on function ... from public`.

## Verdict
**READY WITH FIXES**

The application logic, SQL migrations, and authorization boundaries are production-ready. However, the test suite must be refactored to replace mock-based assertions and SQL string parsing with actual database integration tests before closing P2-09.

## Next Actions
1. Refactor `U-08`, `U-09`, `U-11`, `U-13`, `U-16`, and `U-17` to remove `vi.fn()` and `readFile` in favor of integration tests running against the real PostgreSQL container.
2. After tests are green, the implementation is safe to commit.

## Follow-up Reconciliation - 2026-09-14

No production defect was reproduced. The original review labels covered part of the ADR contract, but the complete mapping for the requested database evidence is:

- normalized duplicate email and HTTP `409 EMAIL_ALREADY_IN_USE`: U-08;
- atomic administrator creation and rollback: U-09;
- login grant without Telegram identity: U-11;
- temporary-password and `password_change_required` lifecycle: U-12;
- privileged mutation audit attribution: U-13;
- self-demotion and last-administrator protection: U-15;
- sequential and concurrent mixed-path invariant preservation: U-16;
- session revocation on deactivation: U-17.

`tests/user-management/admin-user-management-database.test.ts` now starts an isolated loopback PostgreSQL cluster in a newly created temporary directory, applies all 20 migrations, and executes seven behavioral tests against real constraints, functions, transactions, sessions, and audit rows. The concurrency test uses independent PostgreSQL connections and proves that the shared advisory lock permits exactly one of two mutually destructive operations to succeed. Static SQL-shape tests remain only as supplemental guards and are no longer presented as runtime proof.

Validation evidence:

- focused P2-09 tests: 26 passed;
- full suite: 853 passed, 52 skipped because their separately configured external-database prerequisites were absent;
- clean migrations: two independent applications, 20/20 each, schema/security checks passed;
- TypeScript typecheck, build, secret scan, and `git diff --check`: passed.

## Follow-up Verdict

**READY TO CLOSE**

The identified test-quality blockers are closed with disposable-database runtime evidence. Historical migrations were not modified by this follow-up.
