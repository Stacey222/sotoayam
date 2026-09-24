# P2-03 Independent Parity & Release-Readiness Review

## 1. Executive Summary
This review evaluated the P2-03 (Notification Preference Normalization Phase A) implementation. The milestone successfully adds the normalized table and atomic mirror triggers while strictly keeping the legacy booleans authoritative. The resolver supports a read-only `COMPARE` mode that successfully validates recipient set parity without duplicating deliveries or exposing PII. The database test suite is of exceptionally high quality, strictly verifying the backfill, transactional rollback, and exact parity.

## 2. Blocking Findings
*None. Phase A cleanly adheres to the ADR.*

## 3. Non-blocking Findings
*None.*

## 4. Exact-set Parity Assessment
**Status: PROVEN.** 
- The normalized read path `find_shadow_notification_recipients` correctly filters by `active = true` and `enabled = true` for the provided `notification_type`.
- The JS layer safely uses `Set` logic over stable user IDs.
- The `notification-preferences-database.test.ts` suite executes `SELECT id ... ORDER BY id` across both legacy boolean columns and the new RPC for all 7 preference types, verifying absolute array equality. 
- Inactive users are correctly excluded from both sets.

## 5. Shadow-mode Safety Assessment
**Status: SAFE.** 
- Configuration strictly limits `NOTIFICATION_PREFERENCE_RESOLVER_MODE` to `"LEGACY" | "COMPARE"`. `NORMALIZED` does not exist in the code yet, physically preventing an accidental cutover.
- `COMPARE` executes the parallel database query but explicitly drops the result, returning only the `legacy` array to the caller. This guarantees one singular downstream delivery path.
- Logging emits only sanitized metric counts (`mismatch_count`, `legacy_recipient_count`, etc.) without exposing `telegram_chat_id` or user details.

## 6. Remote-read Deviation Assessment
During implementation, seven `SELECT LIMIT 0` calls were executed via a checker script connecting to the linked development Supabase.
- **Persistent State:** No persistent state changed. `SELECT` is strictly a read operation.
- **Secret/Data Exposure:** No data was exposed. `LIMIT 0` retrieves column definitions/metadata only, guaranteeing zero user rows were returned to the executor.
- **Remediation:** No database remediation is required.
- **Prevention:** Checker scripts that instantiate a Supabase client using `.env` variables should assert that `SUPABASE_URL` resolves to a local loopback (`127.0.0.1` or `localhost`), or developers must explicitly unlink their remote project / remove production keys from `.env` before running automated checker tools.

## 7. Migration/Rollback Assessment
- Migration #22 is forward-only, idempotent (using `ON CONFLICT DO UPDATE`), and safely backfills exactly 7 rows per existing active and inactive user.
- The database test explicitly tests the mirror trigger's atomicity by injecting a failing `CHECK` constraint onto the normalized table and observing that the legacy boolean update safely rolls back, preventing partial dual-write states.
- Rollback to `LEGACY` mode consists entirely of an environment variable change, preserving the normalized table for future attempts without data loss.

## 8. Verdict
**PARITY APPROVED**

## 9. Next Steps
**Authorized.** Normalized read cutover (Phase B) may now proceed to the operator-approval step.

## 10. Cutover Record

The approved Phase B cutover was subsequently implemented. `NORMALIZED` is the configured authoritative read mode; the mirrored legacy representation and explicit `LEGACY` mode remain available for rollback without replaying notifications.
