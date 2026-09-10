# P1-05 — Persisted Telegram Offset and Update Deduplication

Status: Implemented
Owner: Claude Code architecture -> Codex implementation
Depends on: P1-02 (bounded outbound HTTP), and the existing scheduler-state / dedupe idioms in
`202609010002_create_task_notification_foundation.sql`
Constrained by: D-002 (one instance per customer), D-003 (one Fastify process), D-004 (PostgreSQL is
the queue/lease/dedupe store), D-006 (Telegram long polling, no webhook), D-014 (additive migrations)

## 1. Problem

`TelegramBot` keeps its polling offset in a private field initialised to zero:

```ts
private offset = 0;
...
for (const update of updates) {
  this.offset = update.update_id + 1;   // advanced BEFORE the handler runs
  ...
  try { await this.handleUpdate(update); } catch { /* logged */ }
}
```

Two distinct defects follow.

**The offset is not durable.** It lives only in process memory and resets to `0` on every restart.
Telegram treats `getUpdates(offset=N)` as an implicit acknowledgement of everything below `N`, so
an update is only confirmed when a *subsequent* call carries a higher offset. If the process dies
after handling a batch but before the next `getUpdates`, nothing in that batch was ever confirmed,
and Telegram redelivers all of it on restart.

**There is no dedupe.** Redelivered updates run through `handleUpdate` a second time. The
consequences are not cosmetic: a repeated `/start` re-runs registration, and a repeated
`callback_query` re-executes a Task Console or IT Console action — a second task transition, a
second access change — with no record that it was a replay.

The in-memory assignment also advances the offset *before* the handler. That ordering is
irrelevant today only because the offset is never persisted; the moment it is persisted, that same
ordering would confirm an update to Telegram before it was processed and **silently lose it**. Any
design here must get the ordering right rather than inherit it.

Everything else the bot does is sound and stays untouched: P1-02's bounded retry client, the
`getMe` startup probe, `allowed_updates`, the 25-second long poll, `RuntimeHealthState`, and the
token/diagnostic redaction helpers.

## 2. Architecture

Three decisions carry the design.

**D-P1-05-A. PostgreSQL holds both the offset and the dedupe ledger.** D-004 already names Postgres
as the queue/lease/dedupe store, and this is exactly that kind of state. No file, no Redis, no new
process. The database is already a hard dependency of every handler, so persisting here adds no new
failure mode.

**D-P1-05-B. The terminal update record and the offset advance commit in one transaction.** They
are a single RPC. This is what removes the "recorded processed but offset not yet moved" window
entirely, rather than merely making it small — see §5 and §10.

**D-P1-05-C. Delivery is at-least-once; processing is effectively-once.** Justified in §4.3. The
alternative — marking an update consumed before running the handler — is at-most-once and loses
updates on a crash, which this task forbids outright.

**D-P1-05-D. Every batch is normalised into strictly ascending `update_id` order before any claim,
and the offset advance is clamped in SQL against the lowest still-`PROCESSING` update.** Two
independent guards, because `greatest(next_offset, update_id + 1)` on its own is unsafe under any
ordering other than ascending — see §4.4 for the loss it would otherwise permit.

Three supporting rules:

- The offset is advanced **only** by the transaction that writes a terminal status. There is no
  other writer, so it can never outrun processing.
- The offset may never advance past an update that is still `PROCESSING`, enforced inside
  `complete_telegram_update` rather than by the caller.
- The in-memory `offset` field becomes a read-through cache of the persisted value, never the
  source of truth.

## 3. Durable state model and schema

One additive migration, `202609120001_create_telegram_polling_state.sql`, bringing the repository
total to **18**. No historical migration is touched.

### 3.1 What is persisted, and what is not

| Persisted | Not persisted |
|---|---|
| `next_offset` — the value to send to the next `getUpdates` | Message text, captions, or any user content |
| One row per update: `update_id`, status, attempt count, coarse type, timestamps, failure class | `chat_id`, `from.id`, usernames, or first names |

Both `update_id` **and** `next_offset` are stored, because they answer different questions.
`next_offset` is what the poller sends to Telegram; the per-update rows are what make a redelivered
update recognisable. Deriving one from the other is not possible: `next_offset` alone cannot tell
whether update `N` finished or crashed mid-handler, and the rows alone cannot be read cheaply
enough to be the polling cursor.

No message content is stored. The dedupe key needs none (§7), and storing chat content would put
customer conversation data into a table that exists purely for bookkeeping.

### 3.2 `telegram_polling_state` — singleton cursor

Follows the established `reminder_scheduler_state` / `critical_alert_evaluator_state` singleton
idiom rather than inventing a new one.

```sql
create table public.telegram_polling_state (
  singleton_key text primary key default 'TELEGRAM_POLLING'
    check (singleton_key = 'TELEGRAM_POLLING'),
  next_offset bigint not null default 0 check (next_offset >= 0),
  last_pruned_at timestamptz,
  updated_at timestamptz not null default now()
);
insert into public.telegram_polling_state (singleton_key) values ('TELEGRAM_POLLING');
```

The row is seeded by the migration, so the poller never has to create it and there is no
"first write races with first read" case.

### 3.3 `telegram_processed_updates` — dedupe ledger

```sql
create table public.telegram_processed_updates (
  update_id bigint primary key,
  status text not null check (status in ('PROCESSING', 'COMPLETED', 'FAILED')),
  attempt_count integer not null default 1 check (attempt_count between 1 and 100),
  update_type text not null check (update_type in ('message', 'callback_query', 'other')),
  failure_class text check (length(failure_class) between 1 and 100),
  received_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  check ((status = 'PROCESSING' and completed_at is null)
      or (status <> 'PROCESSING' and completed_at is not null)),
  check (status <> 'COMPLETED' or failure_class is null)
);

create index telegram_processed_updates_prune_idx
  on public.telegram_processed_updates (completed_at)
  where status <> 'PROCESSING';
```

`update_id` is the primary key, which *is* the dedupe mechanism — no separate unique index, no
hash column. The partial index serves pruning only; the hot path is a primary-key probe.

`failure_class` holds a short classifier (`HANDLER_ERROR`, `ATTEMPTS_EXHAUSTED`,
`MALFORMED_UPDATE`), never a message or stack trace, matching the existing redaction posture.

## 4. Polling lifecycle and processing semantics

### 4.1 Startup

1. `getMe` probe — unchanged.
2. `loadPollingState()` reads `next_offset` and assigns it to the in-memory field.
3. If that read fails, **polling does not start.** The bot logs the failure, leaves
   `runtimeHealth.telegramPollingActive` false, and throws, exactly as it already does when `getMe`
   fails. Starting with a defaulted `offset = 0` after a failed read would replay Telegram's entire
   retained backlog — a silent, self-inflicted duplicate storm. Fail closed.
4. Log the resumed offset once at info level.

On a genuinely fresh install `next_offset` is `0`, so Telegram delivers whatever it still retains.
That is the current behaviour and it is deliberately preserved: skipping the backlog would mean
discarding updates the customer's users actually sent, which contradicts this ADR's central
promise. Operators upgrading a busy instance can pre-seed the row if they want a clean start.

### 4.2 The loop

`getUpdates` is called with the persisted `next_offset`, `timeout=25`,
`allowed_updates=["message","callback_query"]`, through the unchanged P1-02 client.

**Empty batch:** no database write of any kind, no offset change, no log line beyond existing
debug. There is nothing to advance *to* — the next offset is still the same value — so writing
would be pure churn on the most common path of an idle instance. This is explicit because "advance
on empty poll" is a natural-looking mistake that would rewrite the singleton row every 25 seconds
forever.

### 4.3 Per-update ordering

A batch is first **normalised as a whole**, then processed one update at a time:

```
N1. parse           every entry must yield a usable update_id (safe non-negative integer).
                    If ANY entry does not, the whole batch is rejected unprocessed -> §9.3
N2. collapse        exact duplicate update_ids inside one batch collapse to the first occurrence
N3. sort            strictly ascending by update_id
```

Then, for each normalised update, strictly sequentially:

```
a. receive          next update in ascending order (our ordering, not Telegram's promise)
b. classify         coarse type: message | callback_query | other
c. CLAIM            rpc claim_telegram_update(update_id, type, max_attempts)
                      -> 'PROCESS'          no prior row, or a prior PROCESSING row under the cap
                      -> 'SKIP_DUPLICATE'   prior row is COMPLETED or FAILED
                      -> 'SKIP_EXHAUSTED'   prior PROCESSING row exceeded max_attempts
d. handler          await handleUpdate(update)          [only when action = 'PROCESS']
e. COMPLETE         rpc complete_telegram_update(update_id, status, failure_class)
                      writes the terminal status AND advances next_offset  -- one transaction
f. cache            this.offset = returned next_offset
```

`SKIP_DUPLICATE` and `SKIP_EXHAUSTED` skip step (d) but **still run step (e)**. This matters: a
duplicate that did not advance the offset would be redelivered forever. Skipping is not a no-op; it
is a completion.

The claim in (c) is what makes (d) at-most-once *in the absence of a crash*, and the completion in
(e) is what makes the offset trustworthy. Note the inversion of today's code: the offset advances
in (e), after the handler, never before it.

**Semantics: at-least-once delivery, effectively-once processing.**

- *At-most-once* — mark consumed, then handle — loses the update whenever the process dies inside
  the handler. This task forbids silent loss, so it is out.
- *Exactly-once* is unachievable. It would require the handler's side effects (outbound Telegram
  `sendMessage`, plus several independent PostgREST writes) to commit in the same transaction as
  the dedupe row. Telegram's API is not transactional and never will be. Any design claiming
  exactly-once here would be claiming something it cannot deliver.
- *At-least-once with a dedupe ledger* is therefore the honest maximum: every update is processed,
  every duplicate is collapsed, and the only residual re-execution window is a crash strictly
  inside the handler (C3/C4 below), which is bounded by `attempt_count` and always logged.

### 4.4 Why ordering is a correctness requirement, not a convenience

An earlier revision of this ADR processed the batch in arrival order and relied on
`greatest(next_offset, update_id + 1)` alone. That is unsound. Counterexample:

```
batch arrives      [102, 101]          (descending, or any non-ascending order)
102 completes  ->  next_offset = 103
101 claimed, handled, process crashes before complete
restart        ->  polls getUpdates(offset = 103)
                   101 is below the offset and can never be redelivered
```

Update 101 is stranded: a `PROCESSING` row that no future poll can ever satisfy. That is a
permanent loss of a real user action, and it falsified the earlier claim that correctness did not
depend on Telegram's ordering. Two guards now make that claim true rather than assumed.

**Guard 1 — ascending normalisation (N3).** The batch is sorted before the first claim.

*Proof that the offset cannot pass a lower unprocessed update.* Let `M` be the update being
completed. Completion sets `next_offset = M + 1`, which acknowledges every id `≤ M`. Any id `k < M`
is in exactly one of three states:

- `k` was in this batch. Ascending order and strict sequencing mean `k` was completed in an earlier
  iteration, so it is terminal. ∎
- `k` was below the offset this batch was fetched with. Then `k` was already terminal (or pruned
  after being terminal — §7.3), because the offset only ever reaches `k + 1` through `k`'s own
  completion. ∎
- `k` lies between the fetch offset and `M` but is absent from the batch. Telegram returns a
  contiguous ascending prefix of its pending queue, so an absent id is one Telegram will never
  deliver — filtered by `allowed_updates`, or expired. There is nothing to lose. ∎

No fourth case exists, so at the instant `next_offset` becomes `M + 1`, no deliverable update
below `M` is awaiting processing.

**Guard 2 — SQL clamp.** `complete_telegram_update` sets the terminal status first, then computes
`min(update_id) where status = 'PROCESSING'` and refuses to advance past it (§6.1). Guard 1 is a
property of the loop; Guard 2 is a property of the schema. The clamp is what covers the case Guard 1
cannot: two pollers on one token (forbidden by D-003 and the README, but tolerated by §7.4), where
poller B completing 102 while poller A still holds 101 would otherwise strand 101 exactly as above.

Both guards are required. Neither alone is sufficient: sorting cannot see another process's
in-flight work, and the clamp cannot see an update that has not been claimed yet.

Each row states the exact persisted state at the crash instant and the exact behaviour on restart.
Telegram redelivers any update whose `update_id >= next_offset`, so "redelivered" below always
follows from the persisted offset, never from hope.

| # | Crash point | Persisted state | Restart behaviour | Outcome |
|---|---|---|---|---|
| **C1** | After `getUpdates`, before claim | no row; `next_offset = N` | Telegram redelivers `N`; claim inserts fresh | Processed exactly once |
| **C2** | After claim, before the handler's first side effect | row `N` = `PROCESSING`, `attempt_count = 1`; `next_offset = N` | redelivered; claim finds `PROCESSING`, increments to 2, returns `PROCESS` | Processed exactly once |
| **C3** | Inside the handler, side effects partially applied | row `N` = `PROCESSING`; `next_offset = N` | redelivered; retried | **At-least-once.** A partial effect may be repeated. Bounded by `attempt_count`; logged at warn |
| **C4** | After the handler returned, before `complete` | row `N` = `PROCESSING`; `next_offset = N` | redelivered; retried | **At-least-once.** The full handler runs again — the unavoidable window (§4.3) |
| **C5** | Between the terminal write and the offset advance | **cannot occur** | — | The two are one transaction (§6). This window does not exist |
| **C6** | After `complete` committed | row `N` terminal; `next_offset = N + 1` | Telegram does not redeliver `N` | Processed exactly once |
| **C7** | Handler threw (no crash) | row `N` = `FAILED`, `failure_class = HANDLER_ERROR`; `next_offset = N + 1` | not retried | Durably recorded and operator-queryable — not silent |
| **C8** | Repeated crashes on the same update | row `N` = `PROCESSING`, `attempt_count` climbing | on attempt `max + 1`, claim returns `SKIP_EXHAUSTED`, writes `FAILED`, advances offset | Poison pill contained; the bot does not wedge |
| **C9** | Batch arrives non-ascending (e.g. `[102, 101]`); crash after the higher id completed but before the lower one did | With normalisation: `101` terminal, `102` = `PROCESSING`, `next_offset = 101` (clamped) | `101` is at/above the offset, so Telegram redelivers it; claim returns `PROCESS` at attempt 2 | Processed. **Without §4.4's guards this was a permanent loss** |
| **C10** | Batch contains an entry with no usable `update_id` | nothing written; `next_offset` unchanged | the identical batch is redelivered; after `TELEGRAM_MALFORMED_MAX_BATCHES` consecutive rejections polling halts loudly | Nothing acknowledged, nothing invented, nothing lost (§9.3) |

**C5 is the direct answer to "after dedupe persistence but before offset update".** The question
presumes two writes. There is one. `complete_telegram_update` sets the status and the offset inside
a single `plpgsql` function body, which is a single implicit transaction, so no interleaving state
is reachable — not by crash, not by connection loss, not by query cancellation.

**No update is silently lost anywhere in this matrix.** Every row ends in either "processed" or "a
durable `FAILED` record an operator can query." The only cases that repeat work are C3 and C4, and
repeating work is the deliberate, justified trade against losing it.

## 6. Database and transaction model

### 6.1 Functions

Three SECURITY DEFINER functions, each with `set search_path = ''`, revoked from
`public, anon, authenticated`, granted only to `service_role` — the posture established by P1-01
and P1-04.

**`load_telegram_polling_state()` → `bigint`**
Returns `next_offset`. Read-only.

**`claim_telegram_update(p_update_id bigint, p_update_type text, p_max_attempts integer)` →
`table (action text, attempt_count integer)`**

```
insert into telegram_processed_updates (update_id, status, update_type)
values (p_update_id, 'PROCESSING', p_update_type)
on conflict (update_id) do nothing
returning 1  -> inserted?
  yes                      -> ('PROCESS', 1)
  no, existing terminal    -> ('SKIP_DUPLICATE', existing.attempt_count)
  no, existing PROCESSING  -> attempt_count + 1
                              > p_max_attempts -> mark FAILED('ATTEMPTS_EXHAUSTED')
                                                  -> ('SKIP_EXHAUSTED', n)
                              otherwise        -> persist increment -> ('PROCESS', n)
```

`on conflict (update_id) do nothing` is the same idiom the existing notification dedupe uses, and it
is atomic regardless of concurrency.

**`complete_telegram_update(p_update_id bigint, p_status text, p_failure_class text, p_retention_days integer default 7)` →
`bigint` (the new `next_offset`)**

In one transaction, in this exact order:

1. `update telegram_processed_updates set status = p_status, failure_class = ..., completed_at = now() where update_id = p_update_id`
   — the completed row must reach a terminal state **before** step 2 reads, so it does not clamp
   against itself.
2. ```sql
   select min(update_id) into blocking
   from public.telegram_processed_updates where status = 'PROCESSING';

   candidate := p_update_id + 1;
   if blocking is not null then candidate := least(candidate, blocking); end if;

   update public.telegram_polling_state
   set next_offset = greatest(next_offset, candidate), updated_at = now()
   where singleton_key = 'TELEGRAM_POLLING'
   returning next_offset into result;
   ```
3. Throttled prune (§7.3).

Two guards, doing different jobs:

- `greatest(...)` is the **monotonicity** guard — the offset never moves backwards, whatever
  arrives.
- `least(candidate, blocking)` is the **completeness** guard — the offset never moves *forward*
  past an update still awaiting processing. This is Guard 2 of §4.4.

A `PROCESSING` row therefore pins the offset at its own id until it reaches a terminal state, which
is precisely the property that makes C9 recoverable. Exhaustion (C8) marks the row `FAILED`, which
un-pins it, so a permanently stuck update cannot wedge the cursor forever.

**`force_advance_telegram_offset(p_next_offset bigint, p_reason text, p_actor_user_id bigint)` →
`bigint`**

The documented operator recovery path for §9.3's halt. Calls `assert_it_system_admin`, requires
`p_next_offset > next_offset` (it can only skip forward, never replay), writes one `audit_logs` row
(`actor_type = 'USER'`, `action = 'TELEGRAM_OFFSET_FORCE_ADVANCED'`, carrying the old and new
values and the operator's reason), and sets the offset unconditionally.

This exists so that "halt rather than invent an offset" is a recoverable state rather than a dead
end. Skipping updates remains possible, but only as a deliberate, authenticated, audited act by a
system administrator — never as an inference the poller makes on its own.

### 6.2 Atomicity — must the offset and the processed record commit together?

**Yes, and it is the load-bearing decision of this ADR.** If they were separate calls, then:

- terminal-first, offset-second: a crash in between leaves the update marked done with the offset
  still pointing at it. Telegram redelivers, dedupe returns `SKIP_DUPLICATE`, completion runs again
  and advances. Recoverable, but only because the skip path also completes — a subtle dependency
  that a later refactor could break.
- offset-first, terminal-second: a crash in between leaves the update confirmed but with no
  terminal record. Telegram will never redeliver it. **The update is silently lost.** Forbidden.

Making them one transaction removes the ordering question rather than answering it.

### 6.3 Security model and migration shape

Both tables: `enable row level security`, and `revoke all ... from public, anon, authenticated,
service_role`. RPC-only access here is not about secrecy — none of this is sensitive — it is about
the invariant. If `service_role` could `update telegram_polling_state` directly, the guarantee that
the offset only ever advances alongside a terminal record would be a convention rather than a
property of the schema.

One additive migration. It creates two tables, one partial index, two `updated_at` triggers reusing
`public.set_governance_updated_at()`, seeds the singleton row, and defines the four functions. No
`alter` of an existing table, no historical migration edited, no `audit_logs` change (per-update
audit rows would be noise, and the ledger already is the record).

## 7. Dedupe policy

### 7.1 Key

**`update_id`, alone.** Telegram guarantees it is unique and ascending per bot; D-002 and D-006
guarantee one instance and one bot token per customer. There is no second dimension to key on. A
composite key or a payload hash would add width and index cost while protecting against nothing
that can actually happen.

### 7.2 Duplicate and out-of-order behaviour

- **Duplicate `update_id` with a terminal row** → `SKIP_DUPLICATE`. The handler does not run; the
  offset still advances; one warn line is logged with the update id and original status.
- **Duplicate with a `PROCESSING` row** → the C2/C3/C8 path: retry under the attempt cap.
- **Out-of-order batch** → normalisation N3 sorts ascending before the first claim, so the loop
  never observes descending input. Correctness does not rest on Telegram's ordering guarantee —
  but that is now true because the ADR *imposes* the order and clamps the offset in SQL (§4.4), not
  because `greatest()` alone was ever sufficient. It was not: see the C9 counterexample.
- **Duplicate `update_id` within a single batch** → collapsed by N2 to the first occurrence. The
  ledger would catch it anyway; collapsing avoids a pointless round trip.
- **`update_id` below the current offset** → either already terminal in the ledger
  (`SKIP_DUPLICATE`) or pruned, in which case it is processed once more. `greatest()` keeps the
  offset from regressing in both cases.

### 7.3 Retention, pruning, and growth

Terminal rows older than `TELEGRAM_PROCESSED_RETENTION_DAYS` (default 7) **and** with
`update_id < next_offset` are deleted. `PROCESSING` rows are never pruned.

The prune runs inside `complete_telegram_update`, guarded by `last_pruned_at < now() - interval '1 hour'`,
so it executes at most once an hour and needs no scheduler, no extra timer, and no new advisory
lock. It is a plain `delete` — deliberately not the mark-then-delete pattern that turned out to be
dead work in `create_admin_session`.

**Why pruning is safe rather than merely tidy:** the poller only ever calls `getUpdates` with the
persisted `next_offset`, which never decreases. Telegram therefore cannot return an update below
it. A ledger row below `next_offset` has no remaining dedupe duty at all — its retention is purely
so an operator can answer "did we see update N last Tuesday?". Deleting it cannot reintroduce a
duplicate.

Growth is bounded by throughput, not by time: a small business bot sees thousands of updates a
week, so the table holds low thousands of narrow rows in steady state.

### 7.4 Concurrency

One Fastify process (D-003), one polling loop, sequential in-batch processing — there is no
intra-process concurrency to reason about, and the README already forbids two pollers on one token.

The design does not *rely* on that, but the reason is the SQL clamp, not commutativity.
`on conflict (update_id) do nothing` is atomic, and `least(candidate, min PROCESSING)` stops one
poller from acknowledging past another poller's in-flight update — the multi-poller form of the C9
loss. (`greatest()` alone does not achieve this; an earlier revision claimed it did.) Two pollers
would therefore be wasteful rather than corrupting. A distributed lease is deliberately **not** added: it
would solve a problem D-002 and D-003 already exclude, and the existing advisory-lock idiom remains
available if that ever changes.

## 8. Telegram behaviour preserved

- `TelegramApiClient` and `OutboundHttpClient` are **not modified**. P1-05 changes only the body of
  the polling loop and adds a repository dependency.
- `getUpdates` keeps `timeout=25`, `timeoutMs=30_000`, the same `allowed_updates`, and the same
  abort signal, so P1-02's bounded-retry and abort-aware waiting are untouched.
- No webhook. No per-chat pacing (that remains P1-06). No change to send/edit/callback behaviour.
- Polling resumes from the persisted offset after restart, which is the whole point.

## 9. Failure handling

**9.1 Handler throws.** Caught exactly as today, then `complete_telegram_update(id, 'FAILED',
'HANDLER_ERROR')` — terminal, offset advances, no retry. Retrying a deterministic business failure
would loop forever on the same update. The row is the durable evidence.

**9.2 Database unavailable.** If `claim` or `complete` fails, the bot does **not** run the handler
and does **not** advance the offset. It abandons the rest of the batch, logs once at error level,
waits a bounded backoff (`TELEGRAM_DB_BACKOFF_MS`, default 5000, abort-aware so `stop()` stays
responsive), and re-polls with the unchanged offset. Telegram redelivers the whole batch; already
completed updates return `SKIP_DUPLICATE`. Nothing is lost and nothing is double-handled. The
process stays alive so `/health` and the HTTP API keep serving — a database blip must not take down
the web tier.

Explicitly rejected: continuing to process without dedupe while the database is down. That trades
the guarantee for availability of exactly the subsystem that cannot function without the database
anyway, since every handler writes to it.

**9.3 Malformed update — an entry with no usable `update_id`.**

An entry whose `update_id` is missing, non-numeric, negative, or not a safe integer is
**unidentifiable**: it has no key, so it cannot be claimed, cannot be deduped, and — critically —
cannot be acknowledged, because acknowledgement in Telegram's protocol *is* an offset, and this
entry supplies no trustworthy offset value.

The earlier revision said such an entry was skipped and that the loop would advance "using the
batch's maximum valid `update_id + 1`". That is exactly the thing this policy must not do. Since
Telegram acknowledges by offset, advancing on any sibling's id silently acknowledges the
unidentifiable entry too — its real id is somewhere in the batch's range and we simply cannot read
it. Advancing on a sibling is inventing an offset for it by proxy.

**Policy — reject the whole batch, never the entry alone:**

1. **Normalisation N1 is all-or-nothing.** If any entry in the batch fails to yield a usable
   `update_id`, **no** update in that batch is claimed, handled, or completed — not even the valid
   siblings. Partial processing is refused precisely because the malformed entry's true position in
   the ordering is unknowable, so §4.4's ascending proof cannot be established for that batch.
2. **Nothing is written and the offset does not move.** No ledger row, no cursor update. Telegram
   still holds every update in the batch.
3. **One error log per rejected batch**, with a stable `TELEGRAM_MALFORMED_UPDATE` code, the batch
   size, the index of the offending entry, and its *structural fingerprint only* — the sorted list
   of its top-level key names. Never values, never message content, and passed through the existing
   `safeDiagnostic` redaction.
4. **Bounded retry.** The poller waits `TELEGRAM_DB_BACKOFF_MS` and re-polls with the unchanged
   offset. Telegram redelivers the identical batch. A transient parse or transport corruption
   resolves itself here.
5. **Loud halt, not a silent skip.** After `TELEGRAM_MALFORMED_MAX_BATCHES` (default 3) consecutive
   rejected batches, the poller stops: `telegramPollingActive` is set false, one fatal-level line
   is emitted, and the loop exits. **The HTTP tier stays up** — `/health`, the admin API and the
   notification intake keep serving.
6. **Recovery is an authenticated human decision.** The operator inspects the logged fingerprint
   and, if the entry really must be skipped, calls `force_advance_telegram_offset` (§6.1), which
   requires SYSTEM_ADMIN and writes an audit row. The bot then resumes on restart.

**If Telegram ever violates its own `update_id` contract**, this is the exact behaviour: Sotoayam
halts polling and waits for a human, rather than guessing a cursor. The trade is explicit and is
the correct one under the two hard constraints — never invent an offset, never silently
acknowledge an unidentifiable update. Both alternatives fail one of them: skipping the entry
acknowledges it by proxy, and inventing `max + 1` fabricates a cursor from data we just admitted we
cannot parse. A halt is loud, bounded, diagnosable and reversible; a silent skip is none of those.

An entry with a valid `update_id` but an unrecognised *type* is not malformed. It is claimed
normally as `other`, completed, and ignored by `handleUpdate` exactly as today.

**9.4 Duplicate update.** §7.2.

**9.5 Shutdown during processing.** `stop()` aborts the in-flight `getUpdates` and sets `stopped`.
The loop must finish the update it is currently on — including its `complete` call — before
exiting, rather than abandoning it into `PROCESSING`. A bounded grace (`TELEGRAM_SHUTDOWN_GRACE_MS`,
default 5000) caps that wait; on expiry the process exits and the row stays `PROCESSING`, which is
precisely case C3 and recovers on the next start. Graceful shutdown becomes C6 instead of C3, which
is the difference between zero duplicates and one on every routine deploy.

## 10. Operational behaviour

**Restart recovery** is a single info line naming the resumed offset, plus one warn line per
`PROCESSING` row it retries, so a crash is visible in the log rather than inferred.

**Logging** keeps the existing structured fields and redaction. New lines: resumed offset at
startup; duplicate skipped (warn, with the prior status); attempts exhausted (error); database
backoff entered and left (error/info, not per-attempt). No message content, no chat ids beyond what
is already logged.

**Cleanup** is the hourly in-transaction prune of §7.3 — no cron, no extra worker.

**Cost** is one primary-key insert and one narrow update per Telegram update, on a table of a few
thousand rows. For a bot handling hundreds of updates a day this is negligible on the smallest VPS,
and the idle path (empty long poll) performs **zero** database work.

**Configuration** — four optional variables, bounded and validated with the existing helpers:

| Variable | Default | Bounds |
|---|---|---|
| `TELEGRAM_UPDATE_MAX_ATTEMPTS` | `3` | 1–10 |
| `TELEGRAM_PROCESSED_RETENTION_DAYS` | `7` | 1–90 |
| `TELEGRAM_DB_BACKOFF_MS` | `5000` | 1000–60000 |
| `TELEGRAM_MALFORMED_MAX_BATCHES` | `3` | 1–20 |

## 11. Tests and acceptance criteria

`tests/telegram/polling-offset.test.ts` (unit, injected repository)

- **P5-01 Fresh start with no offset** — a seeded singleton at `0` causes `getUpdates` to be called
  with `offset=0`; no assumption of a backlog skip.
- **P5-02 Restart resumes from the stored offset** — a repository returning `4711` causes the first
  `getUpdates` to carry `offset=4711`, not `0`.
- **P5-03 Startup fails closed** — when `load_telegram_polling_state` throws, polling never starts,
  `telegramPollingActive` stays false, and `getUpdates` is never called.
- **P5-04 Duplicate update is not processed twice** — a claim returning `SKIP_DUPLICATE` means
  `handleUpdate` is not invoked, and `complete` is still called so the offset advances.
- **P5-05 Offset advances only after the handler** — asserted by call ordering: `claim` →
  `handleUpdate` → `complete`, and `complete`'s update id equals the handled update's.
- **P5-06 Empty poll writes nothing** — an empty batch triggers zero repository calls and leaves the
  offset unchanged.
- **P5-07 Handler throws** — `complete` is called with `FAILED`/`HANDLER_ERROR`, the offset
  advances, and the loop continues to the next update.
- **P5-08 Attempts exhausted** — `SKIP_EXHAUSTED` skips the handler, completes as `FAILED`, and
  does not wedge the loop.
- **P5-09 Database failure** — a throwing `claim` means the handler does not run, the offset does
  not advance, the batch is abandoned, the process stays alive, and the next poll reuses the same
  offset.
- **P5-10 Malformed update rejects the whole batch** *(changed)* — a batch containing one entry
  without a usable `update_id` produces **zero** claims and **zero** completions, including for the
  valid siblings, and leaves the offset unchanged. Explicitly asserts the old behaviour is gone: no
  advance to `max valid update_id + 1`.
- **P5-22 Malformed batch retries then halts** *(new)* — the identical malformed batch is re-polled
  with an unchanged offset; after `TELEGRAM_MALFORMED_MAX_BATCHES` consecutive rejections polling
  stops, `telegramPollingActive` is false, and no offset was ever written.
- **P5-23 Malformed log carries no content** *(new)* — the emitted line contains the top-level key
  names of the offending entry and no values, no message text, and no raw token.
- **P5-24 Ascending normalisation** *(new)* — a batch delivered as `[102, 101]` is claimed and
  handled in the order `101, 102`; a batch containing a repeated id claims it once.
- **P5-11 Shutdown during processing** — `stop()` mid-handler still results in `complete` being
  called for the in-flight update before the loop exits.
- **P5-12 P1-02 polling behaviour unchanged** — `getUpdates` is still called with `timeout=25`,
  `timeoutMs=30_000`, the same `allowed_updates`, and the same abort signal; a `TelegramApiError`
  still propagates and still stops polling with the existing warn shape.

`tests/telegram/polling-offset-database.test.ts` (opt-in disposable PostgreSQL, reusing the
`SOTOAYAM_TEST_POSTGRES_ADMIN_URL` harness)

- **P5-13 Crash before persistence (C1)** — claim never ran; the offset still points at `N`, so the
  update is claimable fresh.
- **P5-14 Crash after handler, before complete (C4)** — a `PROCESSING` row with the offset still at
  `N`; re-claiming returns `PROCESS` with `attempt_count = 2`.
- **P5-15 Terminal status and offset commit atomically (C5)** — after `complete`, status is terminal
  **and** `next_offset = N + 1`; no state exists with one without the other.
- **P5-16 Offset never regresses** — completing an out-of-order lower `update_id` leaves
  `next_offset` unchanged (the `greatest()` guard).
- **P5-25 Out-of-order crash strands nothing** *(new, the C9 regression test)* — drive the loop with
  the literal batch `[102, 101]`, let `101` complete and then simulate a crash after `102` is
  claimed and handled but before it completes. Assert `next_offset <= 102`, so `102` is still
  redeliverable, and assert that re-claiming `102` returns `PROCESS` at attempt 2. The pre-fix
  design produced `next_offset = 103` with `101` stranded; this test must fail against arrival-order
  processing.
- **P5-26 SQL clamp pins the offset to the lowest PROCESSING id** *(new)* — with `101` left
  `PROCESSING`, calling `complete_telegram_update(102, 'COMPLETED', null)` returns `101`, not `103`.
  Marking `101` `FAILED` then completing `102` returns `103`, proving exhaustion un-pins the cursor.
- **P5-27 `force_advance_telegram_offset`** *(new)* — requires SYSTEM_ADMIN, refuses a value at or
  below the current offset, writes one `TELEGRAM_OFFSET_FORCE_ADVANCED` audit row, and moves the
  cursor.
- **P5-17 Duplicate update_id** — a second claim on a terminal row returns `SKIP_DUPLICATE` and does
  not reset status, `attempt_count`, or `completed_at`.
- **P5-18 Attempt cap** — repeated claims on a stuck `PROCESSING` row return `PROCESS` until the cap,
  then `SKIP_EXHAUSTED` with a `FAILED` row.
- **P5-19 Pruning** — terminal rows older than retention **and** below `next_offset` are deleted;
  rows at or above `next_offset` and all `PROCESSING` rows survive; the prune fires at most hourly.
- **P5-20 RPC-only access** — `service_role` cannot select, insert, or update either table directly;
  only the three functions work.

`tests/migration/`

- **P5-21 Migration integrity** — exactly 18 migrations; all 17 historical hashes unchanged; the new
  file contains only additive top-level statements and no `alter table` against an existing table.

### Acceptance criteria

1. One additive migration; historical migrations byte-identical; 18 total.
2. No new production dependency; no Redis; no new scheduler, worker, or timer.
3. `src/http/outbound-http-client.ts` and `src/services/telegram.service.ts` unchanged (P1-02).
4. No change to admin auth, rate limiting, or integration credentials (P1-01, P1-03, P1-04).
5. The idle path performs zero database writes.
6. Existing Telegram tests pass unmodified except where they must now inject a polling-state
   repository.
7. Typecheck, build, contract tests, governance checks, and secret scan pass.
8. `.env.example`, `README.md`, and `docs/deployment/clean-install.md` document the four variables,
   the at-least-once semantics, and the fact that a crash mid-handler may repeat one update.

## 12. Cross-section consistency check

| # | Checked | Result |
|---|---|---|
| 1 | **Dedupe semantics vs offset advancement** — the explicit requirement | **Consistent.** The offset is advanced by exactly one writer, `complete_telegram_update`, which cannot run without writing a terminal status in the same transaction. The offset therefore can never point past an update that is not terminal, and no terminal update can be left un-advanced |
| 2 | Skip paths vs offset advancement | Consistent — `SKIP_DUPLICATE` and `SKIP_EXHAUSTED` both call `complete`. Had they merely `continue`d, a duplicate would be redelivered forever. Called out in §4.3 because it is the non-obvious half |
| 3 | Crash matrix vs "no silent loss" | Consistent — every crash row ends in processed or a durable `FAILED`. The one ordering that would lose an update (offset before handler, today's in-memory ordering) is explicitly inverted in §4.3 |
| 4 | C5 window vs §6.2 | Consistent — the window is closed by construction, not by narrowing. §6.2 states what each alternative ordering would have cost |
| 5 | Poison-pill `FAILED` (C7) vs at-least-once | Consistent — a handler that *threw* is terminal and never retried; a handler interrupted by a *crash* left no terminal record and is retried. The two are distinguished by whether a terminal status exists, which is unambiguous |
| 6 | Attempt cap vs "no update silently lost" | Consistent — exhaustion writes `FAILED` with `ATTEMPTS_EXHAUSTED`, which is a record, not a deletion |
| 7 | Pruning vs dedupe correctness | Consistent — pruning is bounded by `update_id < next_offset`, and Telegram cannot return an update below the offset the poller sends. Pruned rows have no dedupe duty left |
| 8 | Pruning vs `PROCESSING` rows | Consistent — `PROCESSING` rows are never pruned, so a crashed update cannot be pruned into invisibility and then reprocessed as if new |
| 9 | Empty batch vs offset monotonicity | Consistent — no write at all, so no spurious advance and no idle-time churn |
| 10 | **Out-of-order updates vs offset advancement** — re-checked after the C9 defect | **Consistent, by two guards.** Ascending normalisation (N3) discharges the single-process case with the proof in §4.4; the SQL clamp discharges the multi-poller case. The previous revision claimed this held on `greatest()` alone, which was **false** — C9 shows a permanent loss. Fixed, and P5-25 pins it |
| 17 | Ascending normalisation vs malformed rejection | Consistent, and mutually dependent — §4.4's proof needs every entry's position to be known, which is exactly why §9.3 rejects the whole batch rather than skipping one entry. A partial batch cannot establish the ordering premise |
| 18 | Malformed halt vs "no silent loss" | Consistent — a halt acknowledges nothing, so nothing is lost. The updates stay in Telegram's queue until an operator acts |
| 19 | Malformed halt vs "never invent an offset" | Consistent — the poller has exactly one way past an unidentifiable entry, and it requires an authenticated SYSTEM_ADMIN and an audit row |
| 20 | Malformed halt vs single-VPS availability | Consistent with a cost recorded rather than hidden: a Telegram-side contract violation stops the bot until a human intervenes. The HTTP tier stays up, the failure is fatal-level and diagnosable, and the alternative silently drops user messages |
| 21 | SQL clamp vs poison-pill containment (C8) | Consistent — a `PROCESSING` row pins the cursor, but exhaustion marks it `FAILED`, which un-pins it. A stuck update delays the cursor for at most `TELEGRAM_UPDATE_MAX_ATTEMPTS` polls, never forever |
| 22 | SQL clamp vs pruning (§7.3) | Consistent — pruning never touches `PROCESSING` rows, so it can never remove the row that is pinning the cursor and thereby let the offset jump a gap |
| 23 | SQL clamp vs the atomicity claim (C5) | Consistent — the clamp is computed inside the same transaction, after the terminal write, so the completed row does not clamp against itself and no intermediate state is observable |
| 24 | `force_advance_telegram_offset` vs the RPC-only invariant (§6.3) | Consistent — it is the *only* sanctioned way to move the cursor without a terminal record, it is SYSTEM_ADMIN-gated and audited, and it can only move forward. The invariant becomes "the cursor advances by completion, or by an audited administrative act", which is still a schema property |
| 25 | New RPC vs "one additive migration" | Consistent — a fourth function in the same new migration file; no historical migration touched, still 18 total |
| 11 | Database-unavailable backoff vs duplicate risk | Consistent — abandoning a batch without advancing produces redelivery, which the ledger collapses |
| 12 | Shutdown grace vs C3 | Consistent — graceful shutdown completes the in-flight update (C6); a timed-out shutdown degrades to C3, which is already handled |
| 13 | RPC-only tables vs the offset invariant | Consistent, and this is *why* it is RPC-only: direct `service_role` writes would demote the invariant to a convention |
| 14 | Fresh-install `next_offset = 0` vs "no silent loss" | Consistent — the backlog is processed rather than discarded, preserving current behaviour |
| 15 | P1-02 preservation vs the new loop body | Consistent — the client, timeouts, `allowed_updates`, abort signal, and error shape are untouched; only the loop body changes |
| 16 | New writes vs single-VPS cost | Consistent — two narrow statements per update, zero on the idle path, one hourly prune |

**Unresolved design conflicts: none.**

Two consequences recorded rather than resolved, because both are inherent rather than defects:

1. **C3/C4 mean a crash strictly inside `handleUpdate` can repeat that update's side effects once.**
   No design lacking a transactional Telegram API can remove it. Bounded by `attempt_count`, always
   logged, and the documentation must say so plainly so nobody reads "dedupe" as "exactly once".
2. **A Telegram `update_id` contract violation halts polling until an operator intervenes** (§9.3).
   This is a deliberate availability-for-correctness trade, forced by the two hard constraints, and
   it is loud, bounded and reversible rather than silent.

### Revision note

Revision 2 corrects two defects found in review of revision 1:

- **Out-of-order batches could permanently strand an update** (C9). Revision 1 processed in arrival
  order and relied on `greatest()` alone, and separately claimed correctness did not depend on
  Telegram's ordering. Both are now true only because ascending normalisation and the SQL clamp
  were added; §4.4 carries the counterexample and the proof.
- **Malformed entries were skipped, with the offset advancing to the batch's maximum valid
  `update_id + 1`** — which invented a cursor and acknowledged an unidentifiable update by proxy.
  Replaced by whole-batch rejection, bounded retry, a loud halt, and an audited administrative
  recovery path.

## 13. Verdict

**GO.**

The offset becomes durable, monotonic **and complete** — it never advances past an update still
awaiting processing, proved for the single-process case by ascending normalisation and enforced for
every other case by the SQL clamp; the dedupe ledger collapses every redelivery; the terminal status
and offset advance are one transaction, so the "recorded but not advanced" window does not exist;
the handler-before-advance ordering removes the loss path that the current
in-memory ordering would create the moment it was persisted; an unidentifiable update halts polling
loudly instead of fabricating a cursor; poison updates and crash loops are
bounded and recorded rather than silently dropped or infinitely retried; pruning is provably safe
against the offset; P1-02 and the P1-01/P1-03/P1-04 boundaries are untouched; one additive
migration; no Redis, no new worker, and zero database work when the bot is idle.
