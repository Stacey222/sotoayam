# P0-05 — Persisted Notification Intent and Idempotent Intake

## Status

Approved and implemented by P0-06.

Owner: Claude Code architecture -> Codex implementation (P0-06) -> Antigravity adversarial review.
Inspected: 2026-09-08 against commit `68e877d`, working tree including the untracked P0-04 design.
Supersedes nothing. Implements the intake half of `docs/architecture/database-migration-plan.md` Phase 7.

## Context

`POST /api/notifications/send` is the external intake boundary for n8n and future integrations. `SOTOAYAM_PRD.md` section 5.3 requires that every externally-triggered notification be represented by a persisted intent, that `event_id` provide idempotency, that duplicate intake return the existing result rather than rebroadcasting, and that the existing reliable delivery pipeline be reused. Section 8 requires that duplicate external events do not duplicate delivery and that persisted intents survive process restart. Gate B of section 11 blocks commercial release until this holds.

Binding decisions that constrain the design: D-004 (PostgreSQL remains the queue/lease/dedupe/retry store), D-005 (Supabase/PostgreSQL stays), D-002 (one instance per customer, no tenant scoping), D-003 (one Fastify process), D-008 (external systems call Sotoayam contracts, never the database), D-010 (external intake converges on the persisted intent/delivery model), D-014 (expand/contract migrations).

Two repository facts materially changed this design and are stated up front because the task prompt assumes otherwise:

1. **A mature persisted intent/delivery model already exists** — `public.notifications`, `public.notification_deliveries`, the `create_task_notification` RPC, and `NotificationDeliveryService.processDue()`. It is currently reachable only from the reminder scheduler. External intake shares none of it.
2. **The legacy intake response shape is a frozen contract.** `docs/migration/baseline-v1.md` freezes "Internal notification endpoint authentication and validation", "Seven legacy event-to-boolean recipient mappings", and "Active/preference predicates and per-recipient delivery isolation". `tests/contracts/legacy-contract.test.ts:301` asserts `{ recipients: 1, requested: 1, sent: 1, failed: 0 }` from the HTTP response of a single call. Intake therefore cannot become fire-and-forget in v1.0; the synchronous send counts must survive.

## Current Notification Flow

Exact path as implemented today.

```text
POST /api/notifications/send
  |
  v
src/routes/notifications.routes.ts:13   app.post("/send", handler)
  |  key check INSIDE the handler (not a hook):
  |  secureEqual(headers["x-internal-api-key"], options.internalApiKey) else 401 UNAUTHORIZED
  v
src/validation.ts:82                    parseNotificationEvent(request.body)
  |  type must be one of 7 known types            -> else 400 VALIDATION_ERROR
  |  message non-empty, trimmed, <= 4096 chars    -> else 400 VALIDATION_ERROR
  |  event_id OPTIONAL, string, <= 200 chars      -> else 400 VALIDATION_ERROR
  |  metadata OPTIONAL, must be an object         -> else 400 VALIDATION_ERROR
  v
src/routes/notifications.routes.ts:19   request.log.info({ type, eventId }, "Notification event received")
  |  ^^^ this is the ONLY place event_id is ever used. It is never persisted.
  v
src/services/notification.service.ts:22 NotificationService.send(event)
  |
  +-> src/services/recipient-resolver.service.ts:11  resolve(type)
  |     -> NOTIFICATION_PREFERENCE_BY_TYPE[type]     (src/types/index.ts:15)
  |     -> TelegramUsersRepository.findRecipientsForNotification(preference)
  |          src/repositories/telegram-users.repository.ts:86
  |          select * from telegram_users where active = true and <preference> = true
  |
  +-> Promise.allSettled(recipients.map(r => telegram.sendMessage(r.telegram_chat_id, message)))
  |     src/services/telegram.service.ts, direct Telegram Bot API call per recipient
  |
  +-> sent = fulfilled count; failed = rest
  v
returns NotificationResult { success, type, recipients, requested, sent, failed }
  (returned raw, NOT wrapped in the { success, data } envelope)
  |
  v
HTTP 200 with those counts. Nothing is written to any table. Nothing is retried.
```

The parallel reminder path, which is the mature machinery to reuse:

```text
ReminderSchedulerService (interval, advisory-lock lease)
  -> ReminderEvaluatorService.evaluate()
       -> ReminderRoutingService.resolve(candidate)      -> normalized users.id
       -> dedupeKey = sha256(taskId:eventType:recipientUserId:occurrenceAt)   (evaluator:72)
       -> ReminderNotificationsRepository.createIntent(...)
            -> RPC public.create_task_notification(...)   ONE TRANSACTION:
                 insert notifications ... on conflict (dedupe_key) do nothing
                 if inserted and routed: insert notification_deliveries (PENDING, next_attempt_at = now())
                 upsert task_reminder_states
                 insert audit_logs
                 returns (notification_id, created)
       -> NotificationDeliveryService.processDue(50)
            findDue(now, staleBefore, limit)  -- PENDING, or PROCESSING older than 10 min
            claim(item)                       -- CAS: eq id, attempt_count, state, updated_at
            adapter.deliver(externalId, message)
            markDelivered(id, attempt, at) | markFailed(id, {state, attemptCount, nextAttemptAt, failureClass, failureCode})
              transient -> PENDING, backoff 5 min then 15 min, until attempt >= max_attempts (default 3)
              permanent -> FAILED immediately
```

Relevant existing schema (`supabase/migrations/202609010002_create_task_notification_foundation.sql`):

```sql
public.notifications (
  id, task_id bigint NOT NULL references tasks(id),
  event_type text check (event_type in ('TASK_REMINDER','TASK_ESCALATION')),
  recipient_user_id bigint references public.users(id),
  routing_status text check (in ('ROUTED','UNROUTED')),
  routing_failure_code text check (null or in ('UNASSIGNED','USER_INACTIVE','CHANNEL_MISSING',
                                              'CHANNEL_AMBIGUOUS','ESCALATION_UNROUTED','UNSUPPORTED_CHANNEL')),
  dedupe_key text NOT NULL UNIQUE check (length(dedupe_key) = 64),   -- sha256 hex
  message text check (length(trim(message)) between 1 and 1000),
  occurrence_at timestamptz, created_at timestamptz,
  check ((ROUTED and recipient not null and failure_code null)
      or (UNROUTED and recipient null and failure_code not null))
)

public.notification_deliveries (
  id, notification_id bigint NOT NULL UNIQUE references notifications(id),
  channel, state in ('PENDING','PROCESSING','DELIVERED','FAILED','CANCELLED'),
  attempt_count 0..5, max_attempts 1..5 default 3,
  scheduled_at, next_attempt_at, delivered_at, failure_class, failure_code, created_at, updated_at
)
```

Identity note: `notifications.recipient_user_id` targets normalized `public.users`, whose notification preferences do not exist there — the seven preference booleans live only on legacy `public.telegram_users`. The bridge is `public.users.legacy_telegram_user_id`, a unique FK to `telegram_users(id)` (`202608290002_create_normalized_identity.sql:9`).

## Problem Statement

`event_id` is validated, logged, and discarded. There is no persisted intent, no unique constraint, and no delivery record for external events. Every consequence follows from that single fact:

- an n8n retry after a timeout, a lost response, or an upstream retry policy rebroadcasts the same logical event to every recipient;
- two concurrent submissions of the same event both broadcast in full;
- a crash mid-broadcast leaves no record of which recipients were reached, and no way to resume;
- a transient Telegram failure is reported as `failed` in the response and then permanently lost — the mature retry machine never sees it;
- operators cannot see failed external deliveries, because nothing was written;
- `docs/architecture/current-state-review.md:158` already records this as `PARTIALLY_SUPPORTED`.

Root cause, stated precisely: **the caller's event identity has no durable representation, so the database has no constraint that could reject a duplicate.**

## Goals

- One logical inbound event produces exactly one persisted intent, enforced by a database unique constraint, not by application check-then-insert.
- A caller may retry the same event any number of times, sequentially or concurrently, without a second broadcast.
- Intent creation and its full delivery expansion commit atomically.
- Failed external deliveries enter the existing retry state machine instead of vanishing.
- The frozen legacy request/response contract continues to pass unmodified.
- Additive migration only; no historical migration file is edited.

## Non-Goals

Explicitly not designed or implemented here: Kafka, RabbitMQ, Redis or any broker; microservices; multi-tenancy or tenant IDs; distributed tracing infrastructure; Telegram webhooks; authentication or session changes; a rate-limiting framework; a universal event bus; notification UI; taxonomy-as-data (D-011, P0-13); first-admin bootstrap; a separate delivery-attempt table; replacement of the reminder retry machinery; per-integration credentials (P1-04); making `event_id` mandatory (P2-08).

## Proposed Data Model

Three concepts, two of which already exist. No overlapping structures are introduced.

| Concept | Table | Responsibility | Cardinality |
| --- | --- | --- | --- |
| **Notification intent** | `notification_events` (new) | The logical inbound event. Sole owner of external identity and idempotency. Answers "has this event already been accepted?" | 1 per logical event |
| **Notification (routed intent)** | `notifications` (existing, widened) | One recipient's copy of an intent, with routing outcome. Already exactly this for reminders. | N per event, 1 per recipient |
| **Delivery** | `notification_deliveries` (existing, unchanged) | Channel delivery state and bounded retry metadata for one notification. | 1 per routed notification |
| **Delivery attempt** | *(no table)* | Modelled as `attempt_count` + `max_attempts` + `failure_class` + `failure_code` + `next_attempt_at` on the delivery row. | counter, not rows |

A separate `delivery_attempts` table is deliberately **not** added. The audit praised the existing machine; attempts are already observable through `attempt_count`, the last failure classification, and `audit_logs`. Adding attempt rows would be a new concept with no requirement behind it.

### New table

```sql
create table public.notification_events (
  id bigint generated always as identity primary key,
  source text not null default 'INTERNAL_API'
    check (source ~ '^[A-Z][A-Z0-9_]{0,49}$'),
  external_event_id text not null
    check (length(external_event_id) between 1 and 200
       and external_event_id = trim(external_event_id)
       and external_event_id !~ '[[:cntrl:]]'),
  identity_origin text not null check (identity_origin in ('CALLER', 'GENERATED')),
  event_type text not null check (event_type in (
    'STOCK_CRITICAL', 'PURCHASE_RECOMMENDATION', 'SALES_FOLLOWUP', 'MARKETING_ALERT',
    'CONTENT_OPPORTUNITY', 'OWNER_DAILY_REPORT', 'SYSTEM_ERROR'
  )),
  payload_hash text not null check (length(payload_hash) = 64),
  message text not null check (length(trim(message)) between 1 and 4096),
  recipient_count integer not null default 0 check (recipient_count >= 0),
  routed_count integer not null default 0 check (routed_count >= 0),
  dispatched_at timestamptz,
  dispatch_sent integer not null default 0 check (dispatch_sent >= 0),
  dispatch_failed integer not null default 0 check (dispatch_failed >= 0),
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint notification_events_identity_uidx unique (source, external_event_id)
);

create index notification_events_received_at_idx
  on public.notification_events (received_at desc);
create index notification_events_undispatched_idx
  on public.notification_events (received_at) where dispatched_at is null;

alter table public.notification_events enable row level security;

comment on table public.notification_events is
  'External notification intake intents. Owner of caller event identity and idempotency. Raw caller metadata is never stored; only a payload hash.';
```

Column rationale:

- `source` — the integration namespace. Today every shared-key caller is `INTERNAL_API`. The column exists now so P1-04 (per-integration credentials) can populate real integration codes without a schema change or a re-scoped unique index.
- `external_event_id` — the caller's `event_id`, or a server-generated surrogate. Bounded at 200 to match the existing validator, trimmed, control characters rejected.
- `identity_origin` — `CALLER` when the request supplied `event_id`, `GENERATED` when the server minted one. Makes non-idempotent traffic countable without guessing.
- `payload_hash` — SHA-256 hex of the canonical payload (below). Detects identity reuse with different content.
- `message` — persisted because it is already broadcast and is already persisted per-recipient for reminders. **`metadata` is deliberately not persisted**; only its hash contribution. `notification_deliveries` already carries the rule that raw transport payloads are forbidden.
- `recipient_count` / `routed_count` — the expansion snapshot, written inside the creating transaction.
- `dispatched_at` / `dispatch_sent` / `dispatch_failed` — the synchronous broadcast summary, written after the send. Null `dispatched_at` means the original dispatch never completed and a replay is permitted to resume it.

### Widened existing table

`public.notifications` becomes polymorphic over two parents. Every change is a widening; no existing row is invalidated and no backfill is required.

```sql
alter table public.notifications
  add column notification_event_id bigint references public.notification_events (id);

alter table public.notifications
  alter column task_id drop not null;

-- exactly one parent
alter table public.notifications
  add constraint notifications_single_parent check (
    (task_id is not null and notification_event_id is null)
    or (task_id is null and notification_event_id is not null)
  );

create index notifications_event_id_idx
  on public.notifications (notification_event_id)
  where notification_event_id is not null;
```

Three existing inline CHECK constraints must be widened. **Codex must discover the real constraint names first** — they were created unnamed and Postgres generated them — rather than assuming:

```sql
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'public.notifications'::regclass and contype = 'c';
```

Expected names are `notifications_event_type_check`, `notifications_message_check`, `notifications_routing_failure_code_check`, but the migration must drop by the discovered name and re-add with an explicit name:

| Constraint | Change | Reason |
| --- | --- | --- |
| `event_type` check | add the 7 external types to the allowed list | external events reuse the table |
| `message` check | widen upper bound from 1000 to 4096 | intake already accepts 4096 (`validation.ts:90`); Telegram's own limit is 4096 |
| `routing_failure_code` check | add `'IDENTITY_UNMAPPED'` | a legacy recipient with no normalized `users` row |

`notification_deliveries` is **not modified at all**. Its `notification_id UNIQUE` stays: fan-out is modelled as one `notifications` row per recipient, exactly as the reminder path already does by including the recipient in its dedupe key.

### Per-recipient dedupe key

`notifications.dedupe_key` is `unique` and `length = 64`. External rows reuse it unchanged, computed in TypeScript with `node:crypto` (the same place and manner as `ReminderEvaluatorService.dedupe`, `reminder-evaluator.service.ts:72`) so no Postgres crypto extension is required:

```ts
sha256hex(["NOTIFICATION_EVENT", source, externalEventId, String(legacyTelegramUserId)].join(":"))
```

Namespacing by the literal `NOTIFICATION_EVENT` keeps external keys disjoint from reminder keys in the shared unique index. Note it is keyed on the **legacy** recipient id, which is the identity the resolver actually returns, so the key is stable even if the normalized mapping is created later.

## Idempotency Contract

**Canonical identity: `(source, external_event_id)`**, enforced by `notification_events_identity_uidx`.

Why not `external_event_id` alone: D-009 requires separable integration identities, and P1-04 will issue them. Two integrations may legitimately mint the same counter value (`"1"`, `"order-123"`). Scoping now costs one column and avoids a destructive re-index later.

Why not a tenant or customer column: D-002 fixes one Sotoayam instance per customer. The database *is* the tenant boundary. Inventing a tenant ID would be speculative infrastructure and is explicitly rejected.

Why the shared-key caller is `'INTERNAL_API'`: the intake route authenticates with a single `INTERNAL_API_KEY` and carries no integration identity (`x-integration-code` exists only on `/api/internal/tasks`). Deriving a source from an unauthenticated header would be a caller-asserted identity, which D-009 forbids. Until P1-04, all shared-key traffic shares one namespace — which makes the caller contract below binding.

### Caller contract

| Aspect | Decision |
| --- | --- |
| `event_id` required? | **Optional in v1.0.** Making it mandatory breaks the frozen legacy contract (`legacy-contract.test.ts:283` posts without one) and `docs/migration/legacy-contract.md`. Roadmap **P2-08** already owns "Require external reference where automation idempotency depends on it". |
| `event_id` absent | The server mints `external_event_id = "gen:" + randomUUID()` with `identity_origin = 'GENERATED'`. The request is accepted and behaves exactly as today: **it is not idempotent**, and a retry creates a second intent and a second broadcast. The response carries `idempotent: false` so a caller can detect it. A `warn` log is emitted with the type and no payload. |
| Empty / whitespace `event_id` | `400 VALIDATION_ERROR`. `""` is already rejected today because `validation.ts:99` treats it as falsy; the new rule makes it explicit: after trimming, length must be 1..200. |
| Length limit | 200 characters, unchanged from `validation.ts:91`, now also enforced by a database CHECK. |
| Control characters | Rejected with `400 VALIDATION_ERROR`. Prevents log injection and unreadable operator output. |
| Same identity, same payload | **200**, no new intent, no new deliveries, no rebroadcast. `duplicate: true`. |
| Same identity, different payload | **409 `NOTIFICATION_EVENT_CONFLICT`**, no new intent, no deliveries, no send. The stored payload is never echoed back. |

The conflict outcome is chosen deliberately over silently accepting or silently ignoring the mismatch. Silently accepting the new payload would let a caller mutate an already-broadcast message; silently ignoring it would make the caller believe a different message was delivered. A 409 is the only outcome that cannot mislead the caller, and it is a permanent failure that n8n's contract already says must not be blindly retried (`docs/integrations/n8n-contract.md`).

### Canonical payload hash

```ts
payload_hash = sha256hex(JSON.stringify({
  type,                                  // validated enum
  message,                               // trimmed, as persisted
  metadata: canonicalize(metadata ?? null),  // keys sorted recursively, undefined dropped
}))
```

`canonicalize` must sort object keys at every depth so that key ordering does not produce a false conflict. Arrays keep their order — order is meaningful. The hash covers metadata even though metadata is not stored, so a caller changing metadata under the same event ID is still a conflict.

## Intake Transaction

The Supabase JS client cannot issue multi-statement transactions. The repository already solves this with `security definer` PL/pgSQL functions, one call being one implicit transaction (`create_task_notification`). The same pattern is used here.

**One RPC call is the transaction boundary. Intent creation and complete delivery expansion commit together or not at all.**

```sql
create or replace function public.intake_notification_event(
  p_source text,
  p_external_event_id text,
  p_identity_origin text,
  p_event_type text,
  p_payload_hash text,
  p_message text,
  p_recipients jsonb   -- [{ "legacy_id": 12, "dedupe_key": "<64 hex>" }, ...]
) returns table (
  event_id bigint, created boolean, conflict boolean,
  recipient_count integer, routed_count integer,
  dispatched boolean, dispatch_sent integer, dispatch_failed integer
)
language plpgsql security definer set search_path = ''
```

Body, in order:

1. Validate inputs (`p_event_type` in the 7 types, `length(p_payload_hash) = 64`, `p_identity_origin` in `('CALLER','GENERATED')`, `jsonb_typeof(p_recipients) = 'array'`, array length <= 500). Raise `22023` otherwise, matching the existing convention.
2. Upsert the event and take a row lock in one statement:

   ```sql
   insert into public.notification_events (
     source, external_event_id, identity_origin, event_type, payload_hash, message
   ) values (...)
   on conflict on constraint notification_events_identity_uidx
     do update set external_event_id = excluded.external_event_id   -- no-op, locks the existing row
   returning id, (xmax = 0) as inserted, payload_hash, recipient_count, routed_count,
             dispatched_at is not null as dispatched, dispatch_sent, dispatch_failed
   into v_row;
   ```

   `do update` rather than `do nothing` is required. With `do nothing`, a losing concurrent transaction gets no row back **and** cannot see the winner's uncommitted row, so it would have to re-select and find nothing. `do update` blocks on the winner's row lock, then returns the committed row. The same latent gap exists today in `create_task_notification` (`202609010002...sql:175-180`) — noted as a follow-up below, not fixed here.
3. If `not v_row.inserted`: if `v_row.payload_hash <> p_payload_hash` return `conflict = true`; otherwise return the existing row with `created = false`. **No child rows are written on this path.**
4. If `v_row.inserted`: for each element of `p_recipients`, resolve the normalized identity

   ```sql
   select id into v_user_id from public.users
    where legacy_telegram_user_id = (elem->>'legacy_id')::bigint;
   ```

   then insert one `notifications` row with `task_id = null`, `notification_event_id = v_row.id`, `occurrence_at = now()`, `message = trim(p_message)`, `dedupe_key = elem->>'dedupe_key'`, and either `routing_status='ROUTED', recipient_user_id=v_user_id` or `routing_status='UNROUTED', recipient_user_id=null, routing_failure_code='IDENTITY_UNMAPPED'`. For routed rows only, insert `notification_deliveries (notification_id, 'TELEGRAM', 'PENDING', now(), now())`.
5. Update the event row with the computed `recipient_count` and `routed_count`.
6. Insert one `audit_logs` row: `actor_type 'SYSTEM'`, `action 'NOTIFICATION_EVENT_ACCEPTED'`, `object_type 'NOTIFICATION_EVENT'`, `object_id = id::text`, `after_state` containing source, event type, identity origin, and the two counts — never the message, never metadata — `source 'notification_intake'`.
7. Return `created = true` with the counts.

Grants mirror the existing functions exactly: `revoke all ... from public, anon, authenticated; grant execute ... to service_role;`.

**Crash behavior.** The transaction either commits with the event row, all N notification rows, all routed delivery rows and the audit row, or it commits nothing. There is no state in which an intent exists with a partial expansion. A crash before commit leaves the database untouched and the caller sees a failed request; its retry creates the intent for the first time.

A second, separate write follows the transaction: after the synchronous broadcast, the route updates `dispatched_at`, `dispatch_sent`, `dispatch_failed` on the event row. This is deliberately outside the transaction — it records the outcome of a network side effect that cannot be transactional. `dispatched_at is null` is therefore the durable marker of "expanded but dispatch not known to have completed", and it is what makes scenario E recoverable.

## Concurrent Request Semantics

The unique constraint `notification_events_identity_uidx` is the authoritative defence. An application read before the insert is permitted only as a fast path and must never be the sole gate.

Two simultaneous requests A and B with the same `(source, external_event_id)`:

1. Both may resolve recipients concurrently. This is a read against `telegram_users` and is harmless.
2. Both call `intake_notification_event`.
3. Both attempt the insert. Exactly one acquires the unique index entry.
4. The loser's `on conflict ... do update` blocks on the winner's row lock until the winner commits or rolls back.
5. Winner commits: the loser's statement proceeds against the now-visible row, `xmax <> 0`, so `inserted = false`. It writes no notification rows and no delivery rows, and returns `created = false`.
6. Winner rolls back: the loser's insert succeeds and it becomes the creator.
7. Exactly one caller receives `created = true` and performs the broadcast. The other receives `duplicate: true` and sends nothing.

Isolation level is the PostgREST default, READ COMMITTED. That is sufficient because the guarantee comes from the unique index and the row lock, not from snapshot isolation. `SERIALIZABLE` is not required and is not requested.

Within the broadcast itself, per-recipient concurrency safety comes from the existing `claim()` CAS (`reminders.repository.ts:92`), which updates only when `id`, `attempt_count`, `state` and `updated_at` all still match. Two workers cannot claim the same delivery.

## Delivery Expansion

Recipient resolution is **unchanged**: `RecipientResolverService.resolve(type)` -> `NOTIFICATION_PREFERENCE_BY_TYPE` -> `telegram_users where active and <preference>`. That mapping is a frozen contract and this ADR does not touch it. Taxonomy-as-data is P0-13/P0-14.

Expansion happens once, inside the creating transaction:

```text
notification_events (1)
  └── notifications (N)              one per resolved legacy recipient
        ├── ROUTED    -> notification_deliveries (1)   state PENDING, next_attempt_at = now()
        └── UNROUTED  -> no delivery row               routing_failure_code = 'IDENTITY_UNMAPPED'
```

Uniqueness of the expansion is guaranteed two ways, both by constraint:

- the event row can only be inserted once, and expansion happens only on the inserting path;
- each notification row carries `dedupe_key = sha256("NOTIFICATION_EVENT:source:external_event_id:legacy_id")`, unique across the table. Even a defective code path that attempted a second expansion would be rejected by the index rather than creating duplicates.

The effective delivery uniqueness key requested by the task — intent + recipient + channel — is therefore realised as `dedupe_key` on `notifications` plus the existing `notification_deliveries.notification_id UNIQUE`, rather than as a new composite constraint on the delivery table. This matches current repository semantics exactly and requires no change to the delivery table.

**Recipient count bound.** The RPC rejects arrays longer than 500. A single instance's `telegram_users` population is far below that; the bound exists to make a pathological expansion impossible.

**Known gap, deliberately accepted.** A recipient with no `users.legacy_telegram_user_id` mapping produces an `UNROUTED` notification and no delivery row. It still receives the synchronous broadcast (which addresses `telegram_chat_id` directly), but it gets no retry and no replay resume. This is visible as `routing_failure_code = 'IDENTITY_UNMAPPED'` and countable. It disappears as identity reconciliation completes; `npm run check:reconciliation` already exists to measure it. This is preferred over blocking intake on normalized identity, which would be a behavioural regression against the frozen contract.

## Existing Retry Integration

The delivery state machine is reused verbatim. Nothing in `NotificationDeliveryService`, `claim`, `markDelivered`, `markFailed`, the transient/permanent classification, the 5/15-minute backoff, the `max_attempts` budget, or the 10-minute stale-`PROCESSING` recovery is redesigned.

Intake feeds it by writing delivery rows in exactly the state the machine expects: `PENDING` with `next_attempt_at = now()`.

**Synchronous dispatch** (preserving the frozen response counts) runs immediately after the transaction commits, over the rows just created, using the same sequence the worker uses:

```text
for each created ROUTED delivery:
    claim(delivery)                             -- existing CAS; skip if not claimable
    telegram.sendMessage(legacy telegram_chat_id, message)
    ok   -> markDelivered(id, attempt, now)
    fail -> markFailed(id, { PENDING|FAILED, attempt, nextAttemptAt, failureClass, failureCode })
for each UNROUTED recipient:
    telegram.sendMessage(legacy telegram_chat_id, message)   -- contract parity, no persisted row
then update notification_events set dispatched_at = now(), dispatch_sent, dispatch_failed
```

The send target on this path stays the **legacy `telegram_chat_id`** already held in memory, not `user_channels`. That preserves the frozen recipient/delivery contract exactly and honours `database-migration-plan.md`'s instruction to compare recipient sets before switching resolvers. Later retries by `processDue()` resolve the channel through `user_channels` as they do for reminders; that divergence is the parity risk the migration plan already documents, it affects only retries of failed sends, and its failure codes (`CHANNEL_UNAVAILABLE`, `CHANNEL_AMBIGUOUS`) are visible in `/api/admin/notifications/recent`.

**Anything left `PENDING` is picked up by the existing worker.** No new worker, no new scheduler, no new queue. `ReminderSchedulerService` already calls `processDue(50)` on every tick, and it selects by state and `next_attempt_at` without filtering on event type, so external deliveries are collected automatically.

**Two required application adjustments** in the existing repository, both consequences of `notifications.task_id` becoming nullable:

1. `SupabaseReminderNotificationsRepository.recent()` (`reminders.repository.ts:124`) does `Number(row.task_id)`, which yields `0` for an external row. It must map `task_id` to `number | null`, and `NotificationEventType` in `src/reminders/types.ts:3` must widen to include the external types.
2. `status()` (`reminders.repository.ts:109`) counts delivery states with no event-type filter, so `/api/admin/notifications/status` will begin including external deliveries. This is intentional and desirable — the PRD requires failed deliveries to be visible to operators — but it changes the numbers an operator sees and must be called out in the P0-06 handoff.

## API Behavior

Request and response shapes are additive. No path, status code, error envelope or existing field changes.

**First submission with a caller event ID**

```http
POST /api/notifications/send
X-Internal-Api-Key: <redacted>
Content-Type: application/json

{
  "type": "STOCK_CRITICAL",
  "message": "Stok kritis: SKU-1180 tersisa 3",
  "event_id": "n8n:stock-sweep:2026-09-08T02:00:00Z:SKU-1180",
  "metadata": { "sku": "SKU-1180", "on_hand": 3 }
}
```

```http
HTTP/1.1 200 OK

{
  "success": true,
  "type": "STOCK_CRITICAL",
  "recipients": 4,
  "requested": 4,
  "sent": 4,
  "failed": 0,
  "duplicate": false,
  "idempotent": true,
  "event_id": "n8n:stock-sweep:2026-09-08T02:00:00Z:SKU-1180"
}
```

**Identical retry**

```http
HTTP/1.1 200 OK

{
  "success": true,
  "type": "STOCK_CRITICAL",
  "recipients": 4,
  "requested": 4,
  "sent": 4,
  "failed": 0,
  "duplicate": true,
  "idempotent": true,
  "event_id": "n8n:stock-sweep:2026-09-08T02:00:00Z:SKU-1180"
}
```

`recipients`/`requested` come from the stored `recipient_count`; `sent`/`failed` from the stored `dispatch_sent`/`dispatch_failed`. The caller can treat a retry exactly like an original success; it does not have to know which invocation created the intent. `duplicate` is available for callers that want to distinguish, but nothing in the contract requires reading it.

**Same identity, different payload**

```http
HTTP/1.1 409 Conflict

{
  "success": false,
  "error": {
    "code": "NOTIFICATION_EVENT_CONFLICT",
    "message": "This event_id was already accepted with a different payload"
  }
}
```

**No event_id supplied (legacy caller, unchanged behaviour)**

```http
HTTP/1.1 200 OK

{
  "success": true, "type": "SYSTEM_ERROR",
  "recipients": 2, "requested": 2, "sent": 2, "failed": 0,
  "duplicate": false, "idempotent": false
}
```

The frozen contract test asserts with `toMatchObject`, so the three additive fields do not break it. `AppError(409, "NOTIFICATION_EVENT_CONFLICT", ...)` flows through the existing error handler in `src/app.ts:213` with no change.

## Migration Plan

One additive migration file, following the existing naming convention and expand/contract policy (D-014). No historical migration file is edited.

`supabase/migrations/202609080001_create_notification_event_intake.sql`

| # | Change | Object | Details |
| --- | --- | --- | --- |
| 1 | create table | `public.notification_events` | as specified above; `id` identity PK |
| 2 | constraint | `notification_events_identity_uidx` | `unique (source, external_event_id)` — **the authoritative idempotency guarantee** |
| 3 | index | `notification_events_received_at_idx` | `(received_at desc)` for operator listing |
| 4 | index | `notification_events_undispatched_idx` | partial, `where dispatched_at is null`, for resume/diagnosis |
| 5 | RLS | `notification_events` | `enable row level security`, no policies — deny-all, service_role only, matching every existing table |
| 6 | add column | `notifications.notification_event_id` | `bigint null references public.notification_events(id)` |
| 7 | alter column | `notifications.task_id` | `drop not null` |
| 8 | add constraint | `notifications_single_parent` | XOR over `task_id` / `notification_event_id`; every existing row satisfies it |
| 9 | index | `notifications_event_id_idx` | partial, `where notification_event_id is not null` |
| 10 | replace check | `notifications` event_type | drop discovered name, add `notifications_event_type_allowed` with 2 existing + 7 external types |
| 11 | replace check | `notifications` message | drop discovered name, add `notifications_message_length` with upper bound 4096 |
| 12 | replace check | `notifications` routing_failure_code | drop discovered name, add `notifications_routing_failure_code_allowed` including `'IDENTITY_UNMAPPED'` |
| 13 | create function | `public.intake_notification_event(...)` | `security definer`, `set search_path = ''`, as specified |
| 14 | grants | same function | `revoke all from public, anon, authenticated; grant execute to service_role` |
| 15 | comments | table + column | document that metadata is never stored |

Foreign keys: `notifications.notification_event_id -> notification_events(id)`, no cascade (matching the existing `notifications.task_id` style). Nullability: every new column is either nullable or has a default, so the migration is safe against a populated table. **No backfill is required** — see below.

The whole file runs inside `begin; ... commit;` exactly like `202609010002`.

Steps 10-12 must be written defensively. Codex must query `pg_constraint` for the real names before writing the `drop constraint` lines, and must not assume the generated names.

## Existing Data Compatibility

The database is assumed populated. Behaviour of pre-existing rows:

- **`telegram_users`** — untouched. No column added, no predicate changed. The frozen schema contract fixture (`tests/fixtures/legacy-schema-contract.json`) covers only this table and is unaffected.
- **`notifications` existing rows** — all reminder/escalation rows have `task_id not null` and `notification_event_id null`, so `notifications_single_parent` is satisfied on day one with no backfill. Widening the `event_type`, `message` and `routing_failure_code` checks can only accept more values; no existing row can be invalidated. Postgres validates the new checks against existing rows at `ADD CONSTRAINT` time, which will pass.
- **`notification_deliveries` existing rows** — completely untouched; no DDL is applied to that table.
- **Historical external notifications** — none exist. Before this migration, external events were never persisted, so there is no old row that could lack a meaningful external identity, and no backfill question arises. This is the one genuinely fortunate consequence of the current defect.
- **In-flight requests during deployment** — an intake request served by the old code before the release symlink flips simply broadcasts without persisting, exactly as today. There is no half-migrated state, because the old code writes nothing.
- **Rollback** — reverting the application to the previous release leaves the new table and columns in place and unused. Reminder behaviour is unaffected because reminders always populate `task_id`. No down migration is required, consistent with D-014's preference for tested forward compatibility over universal down migrations.

## Failure Scenario Matrix

| Scenario | Expected Persisted State | Duplicate Delivery Possible? | Why |
| --- | --- | --- | --- |
| **A.** Same event submitted sequentially twice | 1 `notification_events` row, N `notifications`, R `notification_deliveries`; second call writes nothing | No | Second insert hits `notification_events_identity_uidx`, returns `created = false`, and the broadcast branch is never entered |
| **B.** Same event submitted concurrently twice | Identical to A | No | The unique index admits one inserter; the loser blocks on the row lock, then observes `xmax <> 0` and returns `created = false`. No read-then-write race exists because the constraint, not a query, decides |
| **C.** First request commits but the HTTP response is lost | 1 event, N notifications, R deliveries, `dispatched_at` set | No | The caller's retry is case A: it receives 200 with `duplicate: true` and the stored counts, and nothing is re-sent |
| **D.** Process crashes during intake, before the RPC commits | Nothing persisted | No | The transaction never committed. The retry creates the intent for the first time and broadcasts once |
| **E.** Crash after intent persistence, before/during dispatch | 1 event with `dispatched_at is null`, N notifications, R deliveries still `PENDING` (or `PROCESSING` if claimed) | Bounded — at most one duplicate to a recipient claimed-and-sent but not yet marked | Deliveries are resumed by the existing worker: `PENDING` immediately, `PROCESSING` only after the 10-minute stale window. A recipient whose send succeeded but whose `markDelivered` never ran is re-sent once. This at-least-once window is inherent to any non-transactional side effect and is identical to the existing reminder pipeline's behaviour; it is not introduced by this design |
| **F.** Delivery fails transiently | Delivery `PENDING`, `attempt_count` incremented, `next_attempt_at` = +5 min then +15 min, `failure_class 'TRANSIENT'` | No | The existing `markFailed` path. Only one row exists per recipient, so retrying it cannot fan out |
| **G.** Delivery permanently fails | Delivery `FAILED`, `failure_class 'PERMANENT'`, `next_attempt_at null`; also `FAILED` once `attempt_count >= max_attempts` | No | Terminal state; `findDue` selects only `PENDING`/`PROCESSING`. Visible in `/api/admin/notifications/status` and `/recent` |
| **H.** Caller reuses event ID with a different payload | Unchanged — the original event, notifications and deliveries only | No | The RPC compares `payload_hash` before any write and returns `conflict`; the route raises 409 and never resolves recipients into a second expansion |
| **I.** Worker restarts during retry | Delivery left `PROCESSING` with its `updated_at`; reclaimed after the 10-minute stale threshold | Bounded, as in E | Existing stale-recovery semantics, unchanged. The CAS on `(id, attempt_count, state, updated_at)` prevents two workers from claiming the same row |
| **J.** Recipient has no normalized identity | `notifications` row `UNROUTED`, `routing_failure_code 'IDENTITY_UNMAPPED'`, no delivery row | No | Synchronous send only; a replay returns the stored summary and re-sends nothing because the replay path never broadcasts |
| **K.** Two different events, same message and type | 2 event rows, 2 expansions | Not a duplicate | Identity is `(source, external_event_id)`, never the message. Distinct events are distinct intents by design |

## Security Considerations

Authentication is not redesigned. `POST /api/notifications/send` keeps `x-internal-api-key` and `secureEqual`. (Separately noted for P0-04 follow-up: that check sits inside the handler rather than in a hook, so a second route added to that module would be unauthenticated by default. Out of scope here.)

- **No secret can enter the identity or the hash output.** `payload_hash` is a one-way SHA-256 digest; it is stored, never returned, and never logged. `external_event_id` is caller-supplied text and *could* contain a secret if a caller misuses it — it is persisted and appears in logs, so the n8n guidance below states plainly that event IDs must be opaque references, never credentials or personal data.
- **Metadata is never persisted.** Only its hash contribution. This is the single most effective limit on accidental secret storage, and it matches the existing rule on `notification_deliveries` that raw transport payloads are forbidden.
- **Storage is bounded per row**: `external_event_id` <= 200 chars (CHECK, not only application validation), `message` <= 4096, `payload_hash` exactly 64, `source` <= 50 and pattern-constrained. Recipient arrays are capped at 500 per call inside the RPC. Nothing accepts unbounded input.
- **Row growth** is one `notification_events` row plus N `notifications` and R `notification_deliveries` per accepted event. On one small VPS with one customer this is modest, but growth is unbounded over time. Retention/pruning is **not** designed here; it is flagged as a follow-up alongside P2-07 (backup/retention). No index or constraint in this design would be disturbed by adding retention later.
- **Pathological IDs** — control characters and untrimmed whitespace are rejected at both the validator and the CHECK constraint, preventing log injection and identities that differ only by invisible characters.
- **Abuse amplification** — an attacker holding the internal key can already broadcast. This design does not widen that; it narrows it slightly, since a repeated event ID stops rebroadcasting. Rate limiting stays P1-03; nothing here depends on it for correctness.
- **RLS** — `notification_events` is created with RLS enabled and no policies, preserving the deny-all/service_role-only posture. The new RPC is `security definer` with `set search_path = ''` and is granted to `service_role` only, matching every existing function.

## Observability

Log fields only; no new monitoring stack, no metrics backend, no tracing infrastructure.

At intake, one `info` line replacing the current one at `notifications.routes.ts:19`:

```json
{
  "notificationEventId": 8412,
  "source": "INTERNAL_API",
  "externalEventId": "n8n:stock-sweep:2026-09-08T02:00:00Z:SKU-1180",
  "identityOrigin": "CALLER",
  "type": "STOCK_CRITICAL",
  "outcome": "CREATED",
  "recipients": 4,
  "routed": 4,
  "unrouted": 0
}
```

- `outcome` is one of `CREATED`, `REPLAY`, `CONFLICT`, `RESUMED` — this is the replay/new classification the task requires.
- On dispatch completion, a second line adds `sent`, `failed`, and `deliveryIds` (the created delivery row IDs, bounded by the 500 cap; log the count and the ID range if the array is large).
- `CONFLICT` logs at `warn` with the event identity and **no payload, no hash, no message**.
- `identityOrigin: "GENERATED"` logs at `warn` once per request so non-idempotent traffic is countable before P2-08 makes references mandatory.

Never logged: `message`, `metadata`, `payload_hash`, `telegram_chat_id`, any external channel ID, any part of the internal key. This matches `docs/integrations/n8n-contract.md` ("safe correlation references only, never credentials, Telegram external IDs, or sensitive raw payloads") and the existing secret-scan gate (`npm run check:secrets`).

Operator surfaces already exist and need no new endpoint: `/api/admin/notifications/status` and `/api/admin/notifications/recent` will show external deliveries once `recent()` handles a null `task_id`.

## n8n and External Integration Guidance

The API boundary is unchanged; no workflow is designed here. What integrations must do:

- **Send `event_id` on every call.** It is optional in v1.0 only for legacy compatibility. Without it a retry rebroadcasts.
- **Make it globally unique and namespaced.** Until P1-04 issues per-integration credentials, every shared-key caller occupies the single `INTERNAL_API` source namespace, so two workflows using `"1"` would collide. Use `<workflow>:<run-or-business-key>:<discriminator>`, or a UUID. The example above is a good shape.
- **Make it stable across retries and derived from the business event**, not from the attempt. An ID regenerated per attempt provides no idempotency whatsoever.
- **Keep it opaque.** No credentials, no personal data, no Telegram IDs — it is persisted and logged.
- **Treat 409 as permanent.** Per the existing contract, transient transport failures are retried with bounded backoff; validation and conflict responses are not retried blindly. A 409 means the same ID was used for different content, which is a workflow defect.
- **Treat 200 with `duplicate: true` as success.** No compensating action is required or appropriate.

`docs/integrations/n8n-contract.md` should gain a short "Notification intake idempotency" subsection stating these rules; that edit belongs to P0-06.

## Rollout Sequence

1. Apply `202609080001_create_notification_event_intake.sql` to a throwaway database first; confirm the three widened checks pass against seeded reminder rows.
2. Add the intake repository (`SupabaseNotificationIntakeRepository`) wrapping the RPC, plus its interface. No route change yet.
3. Add the payload canonicaliser and hash helper with unit tests (key ordering, nested objects, arrays, null metadata).
4. Extend `parseNotificationEvent` for the tightened `event_id` rules; keep it optional.
5. Introduce `NotificationIntakeService` composing the existing `RecipientResolverService`, the new repository, and the existing `TelegramSender`. The repository dependency is **optional**: when absent, the service behaves exactly as `NotificationService` does today. This preserves the frozen contract tests, which run `buildApp` with an injected in-memory repository and therefore have `client === null` and no Supabase access, matching the conditional-wiring idiom already used throughout `src/app.ts`.
6. Wire it in `src/app.ts` so the persisted path is used whenever `client` is non-null — i.e. always in production. Add a startup log field recording whether persisted intake is active, and a test asserting production wiring supplies the repository.
7. Fix `recent()` for nullable `task_id` and widen `NotificationEventType`.
8. Run the full suite, `npm run typecheck`, `npm run check:secrets`, `npm run check:notification-schema`.
9. Update `docs/migration/legacy-contract.md` (the `event_id` line stating it "is not currently persisted or deduplicated" becomes false), `docs/integrations/n8n-contract.md`, `ROADMAP.md` (P0-05 `[x]`, P0-06 in progress), and `AI_HANDOFF.md`.

No flag day and no feature flag is required: the old behaviour is a strict subset of the new one, and rollback is a release symlink flip that leaves unused schema behind.

## Tests Required for P0-06

Suggested location `tests/notifications/idempotent-intake.test.ts`, plus additions to the existing contract suite. Existing tests must pass unmodified — in particular `tests/contracts/legacy-contract.test.ts` and `tests/app.test.ts`.

**Intake identity and idempotency**

1. First event with a caller `event_id` creates exactly one `notification_events` row, N `notifications` rows and R delivery rows; response `duplicate: false`, `idempotent: true`.
2. Identical retry creates **no** second intent — the fake repository records exactly one insert attempt and the RPC reports `created = false`.
3. Identical retry creates **no** additional `notifications` or `notification_deliveries` rows.
4. Identical retry performs **no** Telegram send — assert `sendMessage` call count is unchanged from the first call.
5. Identical retry returns 200 with the same `recipients`/`requested`/`sent`/`failed` values and `duplicate: true`.
6. Concurrent duplicate intake: two `app.inject` calls issued without awaiting in between, against a repository fake that simulates the unique-constraint outcome (one `created: true`, one `created: false`). Exactly one broadcast occurs, one intent exists, and both callers receive 200.
7. Same identity with a changed `message` returns 409 `NOTIFICATION_EVENT_CONFLICT`, writes nothing, and sends nothing.
8. Same identity with changed `metadata` (message unchanged) also returns 409 — proves metadata is inside the hash.
9. Same identity with metadata keys in a different order returns 200 `duplicate: true` — proves canonicalisation.
10. Two different `event_id`s with identical type and message both broadcast — proves identity is not content-derived.

**Caller contract validation**

11. Missing `event_id` is accepted, responds `idempotent: false`, and a second identical request broadcasts again (documented legacy behaviour).
12. `event_id: ""` and `event_id: "   "` return 400 `VALIDATION_ERROR`.
13. `event_id` of 201 characters returns 400.
14. `event_id` containing a control character returns 400.
15. Unknown `type`, empty `message`, and non-object `metadata` still return 400 — unchanged validator behaviour.

**Transaction and failure behaviour**

16. Repository/RPC failure during intake propagates as an error, and **no** Telegram send occurs — proves persistence precedes side effects.
17. A simulated crash between intent creation and dispatch (repository reports `created: true`, then the sender throws) leaves `dispatched_at` unset; a subsequent identical request resumes rather than re-expanding, and creates no new rows.
18. Expansion is all-or-nothing: an RPC fake that reports partial expansion is treated as a failure, never as success.

**Existing machinery still functions**

19. The existing reminder suite (`tests/reminders/reminder-notification.test.ts`) passes unchanged, including the `claim`/`markDelivered`/`markFailed` and stale-recovery cases.
20. A transient failure on an external delivery leaves the row `PENDING` with `attempt_count = 1` and a future `next_attempt_at`; a permanent failure leaves it `FAILED` — reusing the existing service under an external-event fixture.
21. `processDue()` picks up an external `PENDING` delivery with no event-type filtering.
22. `recent()` returns a row whose `task_id` is `null` without coercing it to `0`.

**Restart/replay**

23. After a simulated restart (new service instance, same repository state), an unfinished dispatch is resumed and already-`DELIVERED` rows are not re-sent.
24. A replay arriving after all deliveries are terminal sends nothing and returns the stored summary.

**Contract preservation**

25. `tests/contracts/legacy-contract.test.ts` passes with no edit to its expectations, including `{ recipients: 1, requested: 1, sent: 1, failed: 0 }`.
26. The seven type-to-preference mappings and the active/preference predicate are unchanged.

## Rejected Alternatives

- **Kafka, RabbitMQ, Redis, or any broker.** Rejected by D-004. Postgres already provides the queue, lease, dedupe and retry primitives this design needs, all of them already in use here. A broker would add an operating cost, a failure mode, and a second source of truth to a single-VPS product for no correctness gain.
- **A universal event bus / outbox pattern.** Rejected as speculative. There is one producer and one consumer in one process (D-003). An outbox would add a dispatcher and a second delivery state machine beside the mature one that already exists.
- **A new `delivery_attempts` table.** Rejected — see the data model. Attempts are already modelled as a counter plus last-failure classification, which the audit found sound.
- **A parallel `notification_event_deliveries` table for external events.** Rejected: it would duplicate `notification_deliveries` and its state machine, creating exactly the overlapping-concept problem this ADR is required to avoid, and would need a second worker.
- **Making `event_id` mandatory now.** Rejected: it breaks the frozen legacy contract and pre-empts P2-08, which already owns that change.
- **Idempotency on `event_id` alone.** Rejected: it forecloses per-integration scoping (D-009, P1-04) and would require a destructive index change later.
- **A tenant or customer column in the identity.** Rejected by D-002 — one instance per customer means the database is the boundary. Inventing tenant IDs is the multi-tenancy non-goal.
- **Application-level check-then-insert.** Rejected outright: it cannot survive concurrent duplicates, and the task and the PRD both require a database constraint as the authority.
- **`on conflict do nothing` plus re-select.** Rejected: a losing concurrent transaction cannot see the winner's uncommitted row and would read nothing. `do update` with a no-op takes the row lock and returns the committed row.
- **Switching intake to fully asynchronous fire-and-forget (202 Accepted).** Rejected for v1.0: it breaks the frozen `sent`/`failed` response contract. It remains the natural evolution once the legacy contract is formally retired.
- **Switching the synchronous send to normalized `user_channels` immediately.** Rejected: `database-migration-plan.md` requires recipient-set parity comparison before a resolver cutover, and the preference booleans still live only on `telegram_users`.
- **Deriving `source` from a caller-supplied header today.** Rejected by D-009 — a caller-asserted identity must not be an identity assertion. The column is present and defaulted so P1-04 can populate it from authenticated credentials.

## Open Questions

Only items that could block P0-06:

1. **`users.legacy_telegram_user_id` coverage.** If a meaningful share of active notification recipients have no normalized `users` row, most external deliveries will be `UNROUTED` and retry coverage will be thin. Codex must run `npm run check:reconciliation` against the target database before implementation and report the mapped/unmapped counts. If coverage is poor, the correct response is to complete reconciliation first, **not** to weaken the design — intake idempotency is unaffected either way, only retry coverage is.

Deliberately not treated as blockers, and recorded here so they are not lost: retention/pruning of `notification_events`; the pre-existing null-`new_id` race in `create_task_notification` (same `on conflict do nothing` pattern, worth fixing when that function is next touched); and the in-handler internal-key check in `notifications.routes.ts` (P0-04 follow-up / P1-04).

## Acceptance Criteria

- [ ] `docs/adr/P0-05-persisted-notification-intent.md` reviewed and accepted before implementation begins.
- [ ] Exactly one new migration file is added; no historical migration file is modified.
- [ ] `notification_events` exists with `unique (source, external_event_id)` as the authoritative duplicate protection, RLS enabled, no policies.
- [ ] `notifications` accepts external rows via a nullable `task_id`, a nullable `notification_event_id`, and an XOR parent constraint; the three widened CHECK constraints are dropped by their **discovered** names and re-added with explicit names.
- [ ] `notification_deliveries` receives no DDL of any kind.
- [ ] Intent creation and full delivery expansion occur in a single `security definer` RPC — one transaction — granted to `service_role` only, with `set search_path = ''`.
- [ ] The RPC uses `on conflict ... do update` (not `do nothing`) so a concurrent loser observes the committed row.
- [ ] No application code relies on check-then-insert as the duplicate defence; a fast-path read, if present, is documented as an optimisation only.
- [ ] Duplicate identical submission returns 200 with the stored counts and `duplicate: true`, and performs zero Telegram sends.
- [ ] Same identity with a different payload returns 409 `NOTIFICATION_EVENT_CONFLICT`, writes nothing, and never echoes the stored payload.
- [ ] `metadata` is never persisted; only its contribution to `payload_hash`.
- [ ] Logs contain intent ID, source, external event ID, identity origin, outcome classification, and delivery counts — and never the message, metadata, hash, or any Telegram ID. `npm run check:secrets` stays clean.
- [ ] External deliveries are created as `PENDING` and are picked up by the existing `processDue()` with no new worker, scheduler, or queue.
- [ ] `NotificationDeliveryService`, `claim`, `markDelivered`, `markFailed`, the backoff schedule, and the stale-recovery window are unmodified.
- [ ] `recent()` handles a null `task_id` and `NotificationEventType` is widened.
- [ ] All 26 test cases above are implemented and pass; `tests/contracts/legacy-contract.test.ts` and `tests/app.test.ts` pass **without any edit to their expectations**.
- [ ] `npm test`, `npm run typecheck`, `npm run build`, `npm run check:secrets` all green.
- [ ] No new runtime dependency; no broker, no cache, no tenant column, no auth change, no rate limiter, no taxonomy change.
- [ ] `docs/migration/legacy-contract.md`, `docs/integrations/n8n-contract.md`, `ROADMAP.md` and `AI_HANDOFF.md` updated to reflect that `event_id` is now persisted and deduplicated.
