# Adversarial Review — Sotoayam P0-06: Idempotent Notification Intake

Reviewer: Antigravity  
Date: 2026-09-08  
Reviewed against: commit `68e877d`, working tree  
Scope: All P0-06 changes — migration, RPC, service, repository, validation, tests

---

## Verdict

**LOLOS**

---

## Executive Summary

P0-06 delivers durable, retry-safe notification intake. The core idempotency claim holds: `(source, external_event_id)` is enforced by a real database unique constraint, the RPC atomically creates the event row, all notification rows, and all delivery rows in one transaction, and concurrent/sequential replays are correctly handled by the `ON CONFLICT ... DO UPDATE` locking pattern rather than application check-then-insert. The frozen legacy API contract remains compatible. No historical migration was modified. RLS is deny-by-default with no new policies. RPC execution is correctly restricted to `service_role`.

The review identified **no critical or high-severity findings**. Four medium-severity and several low/informational observations are documented below. None block P0-06.

---

## Architecture Verification

Reconstructed from code, not from documentation claims:

```text
POST /api/notifications/send
  │
  ├─ notifications.routes.ts:13 → secureEqual(x-internal-api-key) → 401 on fail
  ├─ validation.ts:82 → parseNotificationEvent(body)
  │    type ∈ 7 known types, message trimmed 1..4096,
  │    event_id: optional, 1..200, trimmed, no control chars
  │    metadata: optional, must be object
  │
  ├─ notification-intake.service.ts:71 → send(event)
  │    externalEventId = event.event_id ?? "gen:" + randomUUID()
  │    identityOrigin = CALLER | GENERATED
  │    identity = SOURCE + \0 + externalEventId (in-process dedup key)
  │
  │    ┌─ Application-level serialization (while-loop + Map<identity, Promise>)
  │    │  If concurrent in-process request for same identity, wait for it first
  │    └─ Then:
  │
  │    1. recipientResolver.resolve(type) → telegram_users where active & preference
  │    2. Compute payloadHash via SHA-256 of canonical {type, message, metadata}
  │    3. Compute per-recipient dedupeKey via SHA-256("NOTIFICATION_EVENT:source:id:legacyId")
  │    4. intake.intake({source, externalEventId, identityOrigin, eventType, payloadHash, message, recipients})
  │         │
  │         └─ SupabaseNotificationIntakeRepository.intake()
  │              → client.rpc("intake_notification_event", {...}).single()
  │              │
  │              └─ RPC intake_notification_event (SECURITY DEFINER, search_path='')
  │                   1. Validate all inputs (types, lengths, patterns)
  │                   2. INSERT INTO notification_events ... ON CONFLICT DO UPDATE (locks row)
  │                   3. If existing: compare payload_hash → conflict:true or created:false
  │                   4. If new: loop recipients:
  │                      a. resolve normalized user_id from users.legacy_telegram_user_id
  │                      b. INSERT INTO notifications (task_id=null, notification_event_id=event_id, ...)
  │                      c. If ROUTED: INSERT INTO notification_deliveries (PENDING, now())
  │                   5. UPDATE notification_events SET recipient_count, routed_count
  │                   6. INSERT audit_logs
  │                   7. RETURN created=true, counts
  │                   (entire RPC = one PostgreSQL transaction)
  │
  │    5. On conflict → 409 NOTIFICATION_EVENT_CONFLICT
  │    6. On created=false (replay) → return stored counts, duplicate:true
  │    7. On created=true:
  │         a. Create scoped EventDeliveryRepository (findDueForEvent scoped to this event)
  │         b. Create NotificationDeliveryService with snapshot users/channels
  │         c. processDue() up to 10 batches of 50
  │              → claim (CAS) → deliver via TelegramNotificationAdapter → markDelivered | markFailed
  │         d. Query dispatchState() for final counts
  │         e. Send to UNROUTED recipients directly (legacy compat, no delivery row)
  │         f. completeDispatch() → UPDATE notification_events SET dispatched_at, sent, failed
  │              (guarded by .is("dispatched_at", null) — idempotent)
  │
  └─ Return NotificationResult { success, type, recipients, requested, sent, failed, duplicate, idempotent, event_id? }
```

---

## Findings

### F-001 — In-process serialization map uses `\0` separator but is not strictly necessary for correctness

**Severity:** LOW

**Affected location:** [notification-intake.service.ts:74](file:///c:/Users/Acer/Music/sotoayam/src/services/notification-intake.service.ts#L74)

**Explanation:** The `active` Map uses `SOURCE + "\u0000" + externalEventId` as its key. The NUL byte prevents collision between `source` and `externalEventId`. Since `source` is currently hardcoded to `"INTERNAL_API"`, this is safe. The NUL separator is a reasonable choice, but if `source` ever becomes caller-controlled, any character allowed in both fields could theoretically create a collision. The current validation regex `^[A-Z][A-Z0-9_]{0,49}$` and the external_event_id control-character rejection already prevent NUL in either field.

**Evidence:** Line 74: `const identity = \`\${SOURCE}\\u0000\${externalEventId}\``. Source is const `"INTERNAL_API"` at line 16. The NUL byte cannot appear in a validated external_event_id (control chars rejected at validation.ts:96 and in the RPC).

**Recommended corrective direction:** No action required. The current implementation is safe.

---

### F-002 — Application-level in-process dedup is a fast-path optimization, not the authoritative gate

**Severity:** INFO

**Affected location:** [notification-intake.service.ts:61](file:///c:/Users/Acer/Music/sotoayam/src/services/notification-intake.service.ts#L61), [notification-intake.service.ts:75-89](file:///c:/Users/Acer/Music/sotoayam/src/services/notification-intake.service.ts#L75-L89)

**Explanation:** The `active` Map serializes concurrent in-process requests with the same identity. This is a correct optimization — it prevents unnecessary recipient resolution and RPC calls for obvious in-process duplicates. It is NOT the idempotency gate; the database unique constraint is. If the process crashes after the Map entry is set but before the RPC commits, the Map is lost and the retry correctly creates the intent for the first time. The Map is also correctly cleaned up in `finally` blocks.

**Evidence:** The while-loop at L75 waits for a preceding Promise if one exists. The database `ON CONFLICT` at migration L156 is the actual defense. Tests at idempotent-intake.test.ts:178-186 confirm concurrent HTTP requests serialize correctly.

**Recommended corrective direction:** None needed. Document in ADR that this is an optimization, not a correctness requirement. Already documented in the ADR section "Concurrent Request Semantics".

---

### F-003 — Unrouted recipients receive synchronous send but no delivery tracking or retry

**Severity:** MEDIUM

**Affected location:** [notification-intake.service.ts:161-170](file:///c:/Users/Acer/Music/sotoayam/src/services/notification-intake.service.ts#L161-L170)

**Explanation:** When a legacy `telegram_users` recipient has no corresponding `public.users` row (i.e., `IDENTITY_UNMAPPED`), the RPC creates a `notifications` row with `routing_status='UNROUTED'` and `routing_failure_code='IDENTITY_UNMAPPED'` but no `notification_deliveries` row. The service then sends the Telegram message directly via `Promise.allSettled` (L164-165). If this send fails, the failure is counted in the dispatch summary but never retried — the existing delivery retry machinery has no delivery row to pick up.

This is explicitly documented and accepted in the ADR: "It disappears as identity reconciliation completes." The synchronous send preserves the frozen contract's behavior. The gap is visible via `routing_failure_code='IDENTITY_UNMAPPED'` and countable. Once identity reconciliation is complete (currently 5/5 mapped per AI_HANDOFF), this path is dead code.

**Evidence:** RPC lines 180-201: normalized_user_id is null → UNROUTED, no delivery insert. Service lines 161-170: direct sendMessage for unrouted. AI_HANDOFF: "5 normalized users, 5 Telegram-linked users, 5 mapped, 0 unmapped."

**Recommended corrective direction:** This is an accepted gap documented in the ADR. No action for P0-06. If any future integration has unmapped users, the gap becomes material and should be revisited.

---

### F-004 — Replay after partial dispatch failure returns stale counts until re-dispatch completes

**Severity:** MEDIUM

**Affected location:** [notification-intake.service.ts:135](file:///c:/Users/Acer/Music/sotoayam/src/services/notification-intake.service.ts#L135)

**Explanation:** When a replay request arrives for an event that has `dispatched_at IS NOT NULL` (i.e., the original dispatch completed), the service returns stored `dispatch_sent` and `dispatch_failed` immediately at line 135, without re-examining actual delivery states. If a delivery later succeeds through the background retry machinery, the stored counts become stale — the event row still shows the original dispatch's failure count.

This is a design choice, not a bug: the `dispatch_sent/failed` fields represent the synchronous dispatch outcome, not the eventual delivery outcome. The actual delivery states are visible through `/api/admin/notifications/status` and `/recent`.

**Evidence:** Line 135: `if (outcome.dispatched) return this.result(...)` — returns stored counts. The `completeDispatch` method (repository L118-124) writes once with `.is("dispatched_at", null)`, so it won't overwrite.

**Recommended corrective direction:** Consider documenting explicitly that replay counts reflect the synchronous dispatch, not the eventual delivery outcome. This is not a P0-06 blocker.

---

### F-005 — `completeDispatch` silently succeeds even if no row is updated

**Severity:** MEDIUM

**Affected location:** [notification-intake.repository.ts:118-124](file:///c:/Users/Acer/Music/sotoayam/src/repositories/notification-intake.repository.ts#L118-L124)

**Explanation:** The `completeDispatch` method updates `notification_events` with a `.is("dispatched_at", null)` guard. If `dispatched_at` is already set (e.g., from a concurrent request that completed first), the update matches zero rows. The Supabase client does not throw an error for zero-row updates, so the method silently succeeds. This is actually the desired behavior — it makes the dispatch completion idempotent — but the absence of explicit row-count verification means a genuinely missing event row would also succeed silently.

**Evidence:** Repository line 119-122: `.update({...}).eq("id", eventId).is("dispatched_at", null)`. No `.single()` or row count check.

**Recommended corrective direction:** This is acceptable for P0-06 since the event row must exist at this point (it was just created in the same request). A defensive row-count check could be added as a future hardening measure.

---

### F-006 — Canonical payload hash treats `undefined` metadata and `null` metadata identically

**Severity:** LOW

**Affected location:** [payload-hash.ts:21](file:///c:/Users/Acer/Music/sotoayam/src/notifications/payload-hash.ts#L21)

**Explanation:** `canonicalize(event.metadata ?? null)` maps both `undefined` and `null` metadata to `null` before hashing. Since `parseNotificationEvent` at validation.ts:106 only includes metadata in the event if `body.metadata` is truthy, the event object will have `metadata: undefined` when not supplied and `metadata: {...}` when supplied. Two semantically identical requests — one omitting metadata entirely and one sending `metadata: null` — would produce the same hash. This is correct behavior since both mean "no metadata".

**Evidence:** payload-hash.ts:21: `canonicalize(event.metadata ?? null)`. validation.ts:106: `...(body.metadata ? { metadata: body.metadata } : {})` — falsy metadata (null, undefined) is excluded.

**Recommended corrective direction:** No action needed. The behavior is correct.

---

### F-007 — `SnapshotUsers.findById` returns synthetic user data with hardcoded division/role values

**Severity:** LOW

**Affected location:** [notification-intake.service.ts:44-48](file:///c:/Users/Acer/Music/sotoayam/src/services/notification-intake.service.ts#L44-L48)

**Explanation:** The `SnapshotUsers` class creates synthetic `TaskUser` objects with `divisionId: 1, divisionCode: "INTAKE", roleId: 1, roleCode: "INTAKE"` for any user in the chat IDs map. These values are only used by `NotificationDeliveryService.resolveChannel()` to check that `user.active && user.divisionId !== null && user.roleId !== null`. The synthetic values satisfy these checks. The actual delivery address comes from `SnapshotChannels`, which uses the real `telegram_chat_id` from the recipient resolution. The synthetic user data does not leak into any response or log.

**Evidence:** Lines 44-48: synthetic TaskUser. Delivery service L63-64 only checks `user?.active`, `user.divisionId`, `user.roleId` — all satisfied by the synthetic values.

**Recommended corrective direction:** Consider adding a comment explaining why synthetic values are used. Not a P0-06 blocker.

---

### F-008 — `findDueForEvent` applies stale-processing filter in application code rather than SQL

**Severity:** MEDIUM

**Affected location:** [notification-intake.repository.ts:83-94](file:///c:/Users/Acer/Music/sotoayam/src/repositories/notification-intake.repository.ts#L83-L94)

**Explanation:** The Supabase query at L84-90 fetches deliveries in `PENDING` or `PROCESSING` state with `next_attempt_at <= now`, then the application-level filter at L93 additionally checks `row.state === "PENDING" || row.updated_at <= staleBefore`. This mirrors the existing `SupabaseReminderNotificationsRepository.findDue()` pattern (reminders.repository.ts:85-90) exactly — the same dual-filter approach. The PostgREST API doesn't support the OR-condition-on-different-columns filter needed for `(state=PENDING) OR (state=PROCESSING AND updated_at<=staleBefore)`, so the application-level post-filter is the established pattern.

**Evidence:** Intake repository L92-93 mirrors reminders.repository.ts L90 exactly. Both fetch both states and then filter PROCESSING by stale threshold in application code.

**Recommended corrective direction:** No action for P0-06. This is the established pattern.

---

## Adversarial Cases

### A — Sequential replay: **PASS**

**Evidence:**
- Test `idempotent-intake.test.ts:164-167`: two sequential sends with identical event → `events.size === 1`, `intakeCalls === 2`.
- Test `idempotent-intake.test.ts:168-169`: no duplicate rows → `rows.length === 1`.
- Test `idempotent-intake.test.ts:171-173`: no second Telegram send → `sendMessage called 1 time`.
- Test `idempotent-intake.test.ts:174-177`: replay returns stored counts with `duplicate: true`.
- RPC logic: L164-168 returns `created=false` for existing row, service L135 returns stored dispatch summary. No broadcast path entered.

### B — Concurrent replay: **PASS**

**Evidence:**
- Database defense: `notification_events_identity_uidx` unique constraint (migration L25).
- `ON CONFLICT ... DO UPDATE SET external_event_id = excluded.external_event_id` (migration L156-157) — this is a no-op update that acquires a row lock. The loser blocks until the winner commits.
- `(xmax = 0) as inserted` (migration L158) — the winner sees `inserted=true`, the loser sees `inserted=false` after the winner commits.
- Application-level serialization (service L75-89) prevents unnecessary RPC calls for in-process concurrency.
- Test `idempotent-intake.test.ts:178-186`: concurrent HTTP requests via `Promise.all` → one `duplicate:false`, one `duplicate:true`, exactly 1 event and 1 delivery row, 1 Telegram send.
- No check-then-insert race exists. The constraint, not a query, decides.

### C — Conflicting reuse: **PASS**

**Evidence:**
- RPC L164-168: if `not event_row.inserted` and `event_row.payload_hash <> p_payload_hash`, returns `conflict=true`.
- Service L112-115: on conflict, throws `AppError(409, "NOTIFICATION_EVENT_CONFLICT", "This event_id was already accepted with a different payload")`.
- Test `idempotent-intake.test.ts:188-191`: changed message → 409 with correct error code.
- Test `idempotent-intake.test.ts:193-197`: changed metadata → 409, no extra event, no extra row, no extra Telegram send.
- Conflict response contains only the error code and a generic message. The stored payload is never returned — `payload_hash` is never in logs (verified by grep) and the conflict response has no data fields.

### D — Canonical payload hashing: **PASS**

**Evidence:**
- `canonicalize()` at payload-hash.ts:4-15: recursively sorts object keys via `localeCompare`, maps array elements preserving order, converts `undefined` to `null` in arrays, drops `undefined` object entries.
- Test `idempotent-intake.test.ts:198-202`: reordered nested metadata keys → `duplicate:true` (same hash).
- Test `idempotent-intake.test.ts:238-243`: deeply nested reordered keys → equal hash; reversed array order → different hash.
- `null`, `boolean`, `number`, `string` pass through `canonicalize` unchanged (line 14: `return value`), preserving JSON.stringify distinction between types.
- `JSON.stringify` of the canonical object is deterministic for sorted keys.

### E — Transaction atomicity: **PASS**

**Evidence:**
- The entire RPC runs as one PostgreSQL implicit transaction (PL/pgSQL function body).
- Migration wraps everything in `BEGIN; ... COMMIT;` (lines 1, 237).
- The RPC creates: notification_events row (L151-162), N notifications rows (L185-193), R notification_deliveries rows (L197-199), audit_logs row (L209-220), and updates counts (L204-207) — all within one function call.
- If any INSERT fails (e.g., constraint violation on `dedupe_key`), the entire function aborts and nothing is committed.
- Test `idempotent-intake.test.ts:247-249`: failed intake → 0 events, 0 rows, 0 sends.
- Test `idempotent-intake.test.ts:251-254`: partial expansion mismatch → 503 rejection, 0 events, 0 sends.
- No execution path can create notification_events without notifications (they're in the same transaction). No partial state is possible.

### F — SQL privilege boundary: **PASS**

**Evidence:**
- `SECURITY DEFINER` on L125 — justified because the RPC needs to insert into RLS-protected tables on behalf of the service_role caller.
- `SET search_path = ''` on L126 — prevents search_path hijacking; all table references use `public.` qualification (L151, L181-183, L185, L197, L204, L209).
- `REVOKE ALL ... FROM public, anon, authenticated` at L227-228.
- `GRANT EXECUTE ... TO service_role` at L229-230.
- SQL injection: All RPC parameters are typed PL/pgSQL variables (`text`, `jsonb`), not concatenated into dynamic SQL. The only `EXECUTE format()` in the migration is for dropping discovered constraint names (L56, L77, L95), which uses `%I` (identifier quoting), not user input.

### G — RLS: **PASS**

**Evidence:**
- `ALTER TABLE public.notification_events ENABLE ROW LEVEL SECURITY` at migration L32.
- No `CREATE POLICY` anywhere in the migration (verified by regex grep — zero matches).
- Existing tables (`notifications`, `notification_deliveries`) retain their RLS from the original migration (202609010002 L229-233).
- No existing policy was modified or weakened (no `ALTER POLICY` or `DROP POLICY` in the new migration).
- Deny-by-default is preserved: no role other than `service_role` (via SECURITY DEFINER RPCs) can access these tables.

### H — External event identity validation: **PASS**

**Evidence:**
- **Missing ID:** validation.ts L91-98 makes `event_id` optional. Service L72: `event.event_id ?? "gen:" + randomUUID()`.
- **Empty string `""`:** validation.ts L93: `body.event_id.length < 1` → rejected. Test L231.
- **Whitespace-only `"   "`:** validation.ts L95: `body.event_id !== body.event_id.trim()` → rejected (trimmed version is shorter). Test L231.
- **1 char:** Accepted — length 1 is within `1..200`.
- **Exactly 200 chars:** Accepted — within bound.
- **201 chars:** validation.ts L94: `body.event_id.length > 200` → rejected. Test L232.
- **Newline `\n`:** validation.ts L96: `/[\u0000-\u001f\u007f-\u009f]/u.test(body.event_id)` → `\n` is U+000A, rejected. Test L233.
- **Tab `\t`:** U+0009, caught by same regex → rejected.
- **Control characters:** Caught by regex range `\u0000-\u001f` and `\u007f-\u009f` → rejected.
- **Unicode:** Allowed — the regex only rejects control chars, not valid Unicode text. This is correct.
- **Same ID, different source:** Different `(source, external_event_id)` → different unique constraint entry → distinct events. RPC validates source against `^[A-Z][A-Z0-9_]{0,49}$`.
- **Database double-check:** RPC L136-148 re-validates all inputs including external_event_id length, trimming, and control characters. Migration CHECK constraint at L7-10 enforces the same rules.

### I — Missing event_id compatibility: **PASS**

**Evidence:**
- Service L72-73: missing `event_id` → `"gen:" + randomUUID()`, `identityOrigin = "GENERATED"`.
- Each call generates a unique UUID → unique `external_event_id` → unique constraint satisfied → new event created every time → explicitly non-idempotent.
- Service L194: `idempotent: identityOrigin === "CALLER"` → `false` for generated IDs.
- Service L195: no `event_id` field in response when identity is generated.
- Test L226-229: two calls without event_id → 2 events, 2 sends, both `idempotent: false`.
- The generated IDs use prefix `"gen:"` which satisfies the external_event_id validation (no control chars, 1..200 length).
- Non-idempotent traffic is fully isolated — it cannot interfere with idempotent events because each gets a unique identity.
- Service L132: generated identity logs a `warn` for operational visibility.

### J — Crash-window analysis: **PASS**

**Evidence:**

1. **Crash before RPC commit:** Transaction never committed → nothing persisted → retry creates the intent for the first time. Correct.

2. **Crash after persistence but before Telegram dispatch:** Event row exists with `dispatched_at IS NULL`, notification and delivery rows exist in `PENDING`. On retry: service calls `intake()` → RPC returns `created=false, dispatched=false` → service enters the "RESUMED" path (L120) → creates scoped delivery repository → calls `processDue()` → existing delivery machinery picks up PENDING rows → delivers → calls `completeDispatch()`. Test L256-261 confirms this flow.

3. **Crash after Telegram accepts but before DB marks DELIVERED:** Delivery row stuck in `PROCESSING`. After 10-minute stale threshold, the existing `processDue()` reclaims it via CAS and re-delivers. This is the accepted at-least-once window. Identical to the reminder pipeline's behavior (delivery-service.ts L34: `10 * 60_000`).

4. **Crash after delivery state update but before HTTP response:** Event dispatched_at may or may not be set. On retry: if dispatched_at is set, L135 returns stored counts. If not set, the RESUMED path re-examines delivery states and completes dispatch. Either way, no double-send occurs for already-DELIVERED rows (CAS prevents re-claim).

### K — Delivery state regression: **PASS**

**Evidence:**
- External deliveries are created in `PENDING` state with `next_attempt_at = now()` (RPC L197-199).
- Synchronous dispatch uses `NotificationDeliveryService.processDue()` (service L156) — the exact same class used by the reminder scheduler (app.ts L165).
- `processDue()` calls: `findDue` → `claim` (CAS) → `deliver` → `markDelivered` | `markFailed` (delivery-service.ts L32-57).
- Failure classification: `TRANSIENT` (retry with backoff) vs `PERMANENT` (immediate FAILED) — delivery-service.ts L70-79.
- Backoff: 5 min for attempt ≤ 1, 15 min thereafter — delivery-service.ts L50.
- Max attempts: `attempt >= max_attempts` → FAILED — delivery-service.ts L49.
- Stale PROCESSING recovery: 10-minute threshold — delivery-service.ts L34.
- No direct Telegram path bypasses delivery state transitions for ROUTED recipients. The only direct send is for UNROUTED recipients (no delivery row exists), which is the documented legacy compat path.
- Test L263-266: transient failure → `state: "PENDING", attempt_count: 1, failure_class: "TRANSIENT"`.
- Test L268-271: permanent failure → `state: "FAILED", failure_class: "PERMANENT"`.
- Test L272-278: `processDue` correctly consumes an external notification.

### L — Replay after delivery failure: **PASS**

**Evidence:**
- On replay of an already-dispatched event: service L135 returns stored dispatch summary. No re-examination of delivery states, no re-send. The `dispatched_at IS NOT NULL` condition short-circuits.
- On replay of a partially-dispatched event (`dispatched_at IS NULL`): the RESUMED path at L139-174 re-runs `processDue()`, which only picks up PENDING or stale-PROCESSING rows. Already-DELIVERED rows are not re-claimed (their state is `DELIVERED`, not `PENDING`).
- The `completeDispatch` write at L171 uses `.is("dispatched_at", null)` — if another request already completed dispatch, this is a no-op.
- Test L256-261: resume after dispatch-summary failure → `duplicate: true, sent: 1, failed: 0`, only 1 Telegram send total.
- Test L288-292: new service instance returns stored terminal results without sending.
- No code path recreates notification or delivery rows on replay — the RPC returns `created=false` and the child-row insertion loop is never entered.

### M — Unrouted identity behavior: **PASS**

**Evidence:**
- RPC L180-183: `normalized_user_id := null` when no `users` row matches `legacy_telegram_user_id`.
- RPC L189-191: `routing_status='UNROUTED', recipient_user_id=null, routing_failure_code='IDENTITY_UNMAPPED'`.
- No fake normalized user is created — the SELECT at L181-183 is a read-only lookup.
- The recipient is not silently dropped — a `notifications` row is created with `UNROUTED` status, countable and visible.
- Idempotency is intact — the event row and notification rows are created atomically, and a replay returns the same counts.
- Test L207-213: unmapped recipient → 0 delivery rows, 1 unrouted entry, `recipients: 1, sent: 1` (synchronous send succeeded), replay returns `duplicate: true`.
- The synchronous send for unrouted recipients at service L164-165 uses `Promise.allSettled`, so it cannot throw and cannot trigger a retry loop that would cause duplicate sends.

### N — Frozen API contract: **PASS**

**Evidence:**
- `NotificationResult` interface at notification.service.ts:6-16: `success`, `type`, `recipients`, `requested`, `sent`, `failed` are required. `duplicate`, `idempotent`, `event_id` are optional (marked with `?`).
- Legacy contract test L299-303: `expect(accepted.json()).toMatchObject({ recipients: 1, requested: 1, sent: 1, failed: 0 })` — uses `toMatchObject`, which allows additive fields.
- All 9 contract tests pass (verified by running `npm run test:contract`).
- The `buildApp` function at app.ts:124-127 conditionally creates `NotificationIntakeService` when both `notificationIntakeRepository` and `reminderNotifications` are available, otherwise falls back to the original `NotificationService`.
- Contract test at legacy-contract.test.ts:282 does NOT supply `notificationIntakeRepository`, so it gets the legacy `NotificationService` — the contract test validates the original behavior is preserved.
- The intake service's `result()` method at service L186-196 produces the same fields plus the additive ones.

### O — Existing reminder compatibility: **PASS**

**Evidence:**
- Migration L36: `ALTER TABLE public.notifications ALTER COLUMN task_id DROP NOT NULL` — nullable now.
- Migration L37-40: `notifications_single_parent` CHECK: `(task_id IS NOT NULL AND notification_event_id IS NULL) OR (task_id IS NULL AND notification_event_id IS NOT NULL)`.
- All existing reminder rows have `task_id NOT NULL` and `notification_event_id IS NULL` (column just added, defaults to NULL) → satisfy the XOR constraint.
- `create_task_notification` RPC at 202609010002 L169-175: always sets `task_id = p_task_id` (NOT NULL for reminder calls) and does not set `notification_event_id` → NULL. The XOR constraint is satisfied.
- `recent()` at reminders.repository.ts L124: `task_id: row.task_id === null ? null : Number(row.task_id)` — handles null task_id.
- Test L280-287: null task_id in recent results works correctly.
- Event type widening: migration L59-63 adds 7 new types while retaining `TASK_REMINDER` and `TASK_ESCALATION`.
- Message length widening: migration L80-81 changes upper bound from 1000 to 4096. All existing rows with messages ≤ 1000 satisfy the new check.
- Routing failure code widening: migration L98-103 adds `IDENTITY_UNMAPPED`. All existing values remain valid.

### P — Migration safety: **PASS**

**Evidence:**
- Exactly one new migration: `202609080001_create_notification_event_intake.sql` (13th file in ordered list).
- No historical migration modified: `git diff bd5fdd3..HEAD` on historical migration files returns empty (verified by command).
- Constraint discovery: migration L44-58, L65-79, L83-97 use `SELECT INTO STRICT` from `pg_constraint` with `attname` matching to discover real constraint names. `INTO STRICT` raises `NO_DATA_FOUND` if the constraint doesn't exist, causing the migration to fail clearly rather than silently proceeding.
- `EXECUTE FORMAT('ALTER TABLE ... DROP CONSTRAINT %I', constraint_name)` at L56, L77, L95 uses `%I` for safe identifier quoting.
- All new columns have defaults or are nullable: `notification_event_id` is `bigint` nullable, `task_id` is changed to nullable.
- Migration wraps in `BEGIN; ... COMMIT;` — all-or-nothing.

### Q — Logging / sensitive data exposure: **PASS**

**Evidence:**
- Service L121-131: logged fields are `notificationEventId`, `source`, `externalEventId`, `identityOrigin`, `type`, `outcome`, `recipients`, `routed`, `unrouted`. No `message`, no `metadata`, no `payloadHash`, no `telegram_chat_id`.
- Service L172-173: dispatch log includes `notificationEventId`, `source`, `externalEventId`, `outcome`, `deliveryCount`, `sent`, `failed`. No sensitive data.
- Service L113: conflict log includes `notificationEventId`, `source`, `externalEventId`, `outcome: "CONFLICT"`. No stored payload revealed.
- Test L214-222: explicit assertion that logs do not contain `sensitive-message`, `sensitive-metadata`, chat ID `99887766`, or the payload hash.
- Grep confirms: `payload_hash` appears only in the repository's RPC call parameter (L62), never in any log statement.
- `telegram_chat_id` does not appear in the intake service file at all (confirmed by grep).
- Secret scan: PASS (verified by running `npm run check:secrets`).

### R — Real database test quality: **PASS (with documented limitations)**

**Evidence:**
- Tests use an in-memory `Store` class that simulates the repository behavior (test L56-144).
- The `Store` correctly models: event uniqueness by key, conflict detection by hash comparison, delivery state transitions, unrouted tracking.
- SQL assertions at test L308-316: read the actual migration file and verify constraint names, `ON CONFLICT` semantics, `SECURITY DEFINER`, `search_path`, RLS enablement, grant/revoke patterns.
- Integration test at L296-306: uses `buildApp` with real app wiring, verifying end-to-end HTTP flow through Fastify.
- Concurrent test at L178-186: uses `Promise.all` on two HTTP requests. This tests application-level concurrency but NOT database-level concurrency (the Store is single-threaded JavaScript).

**Limitation:** True PostgreSQL concurrent transaction testing (two sessions racing on the unique constraint) is not performed. This is explicitly documented as P1-09 ("Migration tests against clean throwaway Postgres") in the roadmap. The SQL analysis confirms the `ON CONFLICT DO UPDATE` pattern is correct for READ COMMITTED isolation, and the `xmax = 0` idiom is a well-established PostgreSQL pattern.

### S — Source identity semantics: **PASS (with accepted limitation)**

**Evidence:**
- `SOURCE` is hardcoded to `"INTERNAL_API"` at service L16.
- The caller cannot control the source — it is not taken from any request header or body field.
- All callers authenticated by the same `x-internal-api-key` share the `INTERNAL_API` namespace.
- Per-integration credentials and authenticated source identity are deferred to P1-04 (D-009, roadmap).
- The database column and constraint are already in place for future per-source isolation.

### T — Replay summary correctness: **PASS**

**Evidence:**
- `dispatched_at IS NOT NULL` → return stored `dispatch_sent`/`dispatch_failed` (service L135).
- `dispatched_at IS NULL` → resume dispatch, compute fresh counts from delivery states (service L160-170), then write dispatch summary once (service L171).
- `completeDispatch` uses `.is("dispatched_at", null)` guard (repository L122) — prevents accidental overwrite.
- Stale counts after background retry are possible (see F-004) but this is the dispatch-time snapshot, not an eventual consistency promise.
- Test L174-177: replay returns `{ ...first, duplicate: true }` — identical counts.
- Test L288-292: cross-instance replay returns stored counts.
- The `dispatchState` query at repository L96-115 reads actual notification/delivery state, not the cached event counts, for the dispatch path — so the RESUMED path gets fresh data.

---

## Database / Concurrency Assessment

- **Is `(source, external_event_id)` truly database-enforced?**
  YES. `CONSTRAINT notification_events_identity_uidx UNIQUE (source, external_event_id)` at migration L25. Verified by reading the migration SQL and by the SQL assertion test at idempotent-intake.test.ts:310.

- **Can concurrent identical calls create two intents?**
  NO. The unique constraint prevents two rows. The `ON CONFLICT DO UPDATE` acquires a row lock on the winner's row, blocking the loser until the winner commits. The loser then sees `xmax <> 0` (not inserted) and returns `created=false`.

- **Can they create duplicate deliveries?**
  NO. Delivery creation happens only on the `created=true` path (RPC L171-202). The loser gets `created=false` and never enters that loop. Additionally, each notification has a unique `dedupe_key`, providing a second layer of defense.

- **Is the transaction boundary atomic?**
  YES. The RPC is a PL/pgSQL function — its entire body runs in one implicit transaction. If any statement fails, the entire function rolls back.

- **Are SQL privileges safe?**
  YES. `SECURITY DEFINER` with `SET search_path = ''`. `REVOKE ALL FROM public, anon, authenticated`. `GRANT EXECUTE TO service_role`. All table references are schema-qualified with `public.`.

---

## API Compatibility Assessment

The frozen legacy response behavior **remains compatible**.

- All existing response fields (`success`, `type`, `recipients`, `requested`, `sent`, `failed`) continue to be returned with the same semantics.
- Three additive fields (`duplicate`, `idempotent`, `event_id`) are optional in the `NotificationResult` interface and do not break existing callers using `toMatchObject` assertions.
- The legacy `NotificationService` (without persistence) is still used as a fallback when repository dependencies are not available.
- All 9 contract tests pass without modification.
- The error envelope for 409 follows the existing `AppError` → error handler pattern at app.ts:224-244.

---

## Security Boundary Assessment

### RLS
- `notification_events` has RLS enabled (migration L32), no policies created (verified by regex and grep).
- All existing RLS-protected tables retain their RLS from original migrations.
- Deny-by-default posture preserved.

### SECURITY DEFINER
- Justified: the RPC must insert into RLS-protected tables.
- `SET search_path = ''` prevents search_path hijacking.
- All table references are schema-qualified (`public.*`).
- Matches the existing pattern of `create_task_notification`, `try_acquire_reminder_scheduler_lease`, `complete_reminder_scheduler_run`.

### EXECUTE grants
- `REVOKE ALL FROM public, anon, authenticated` (migration L227-228).
- `GRANT EXECUTE TO service_role` (migration L229-230).
- Matches existing grant pattern exactly.

### Source identity
- Hardcoded to `"INTERNAL_API"`. Not caller-controlled.
- Per-integration identity is deferred to P1-04 per D-009.
- The database column exists and is ready for future use.

### Logging / secret exposure
- No message content, metadata, payload hash, Telegram identifiers, API keys, or Supabase credentials appear in any log statement (verified by code inspection and test L214-222).
- Conflict responses contain only a generic error code and message, no stored payload.
- Secret scan passes.

---

## Test Quality Assessment

**Confidence level: HIGH for application logic, MODERATE for database concurrency.**

### Strengths
- 32 focused notification intake tests covering: sequential replay, concurrent replay, conflict detection, canonical hashing, crash recovery, delivery state transitions, unrouted handling, sensitive data logging, legacy compatibility, and contract preservation.
- SQL assertions verify actual migration file contents (constraint names, RLS, grants).
- Integration tests use real Fastify HTTP injection.
- The `Store` mock faithfully reproduces the repository contract including conflict detection, state transitions, and scoping.

### Identified gaps
1. **No real PostgreSQL concurrency test.** The concurrent test at L178-186 runs two HTTP requests against in-memory storage. True two-session database concurrency testing is deferred to P1-09. The SQL analysis confirms correctness of the `ON CONFLICT DO UPDATE` + `xmax = 0` pattern.
2. **Mock Store cannot reproduce database constraint violations.** A mock that silently accepts invalid dedupe_keys or bypasses CHECK constraints provides false confidence about edge cases that would fail at the database level.
3. **No test for the `NOTIFICATION_INTAKE_INCOMPLETE` rejection path with real data.** The test at L251-254 uses a mock flag, not an actual RPC miscount.

These gaps are acknowledged and appropriate for v1.0. They do not mask any correctness issue in the implemented code.

---

## Residual Risks

### Accepted / Deferred

1. **At-least-once Telegram delivery in the crash window** — accepted per ADR. Telegram send succeeds but DB not yet updated → re-delivery on retry. Identical to reminder pipeline behavior. (Known limitation #1)

2. **Missing `event_id` remains non-idempotent** — accepted for legacy compatibility per ADR. Generated UUIDs prevent collision with caller-provided IDs. (Known limitation #2)

3. **`notification_events` retention/pruning** — not implemented. Rows grow unbounded. Deferred alongside P2-07. (Known limitation #3)

4. **`create_task_notification` ON CONFLICT DO NOTHING visibility gap** — the existing reminder RPC uses `DO NOTHING` which doesn't block/return on conflict. ADR documents this as a pre-existing issue. P0-06 does not make it worse. (Known limitation #4)

5. **Source identity relies on shared integration credential** — pending P1-04. P0-06 does not expand the attack surface. (Known limitation #5)

6. **Stale replay counts** (F-004) — dispatch_sent/failed reflect synchronous dispatch time, not eventual delivery outcome. Actual delivery states are visible through admin endpoints.

7. **UNROUTED recipients lack retry** (F-003) — accepted while identity reconciliation is at 5/5. Becomes material if reconciliation regresses.

### Blocking

**None.**

---

## Validation

| Command | Result |
|---------|--------|
| `npx vitest run tests/notifications` | ✅ 32 tests passed |
| `npx vitest run tests/contracts` | ✅ 9 tests passed |
| `npx vitest run` (full suite) | ✅ 532 tests passed (25 test files) |
| `npx tsc -p tsconfig.json --noEmit` | ✅ Clean (exit code 0) |
| `npx tsx scripts/check-secrets.ts` | ✅ SECRET_SCAN = PASS |
| `git diff bd5fdd3..HEAD -- supabase/migrations/2026080* ... 2026090200*` | ✅ Empty (no historical migration modified) |
| `git log --oneline -20` | ✅ HEAD at 68e877d |

> [!NOTE]
> `npm run check:notification-schema` was not run because it contacts a live Supabase instance (creates a client from env vars). The migration SQL was verified by direct file inspection and SQL assertion tests instead.

---

## Gate Decision

**P0-06 MAY PROCEED**

The implementation faithfully realizes the approved ADR. Database-enforced idempotency, atomic transaction expansion, correct concurrent request semantics, preserved legacy compatibility, deny-by-default RLS, and hardened RPC privileges are all verified from code. No critical or high-severity findings were identified. All 532 tests pass, typecheck is clean, and secret scan passes. The residual risks are either explicitly accepted limitations documented in the ADR or deferred to later roadmap items, and none are made worse by P0-06.
