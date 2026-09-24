# ADR P2-03 — Normalize Existing Notification Preferences

## Status

Implemented. Phase A established normalized storage, mirrored writes, and exact parity proof. The independent parity review approved Phase B, and `NORMALIZED` is now the authoritative read mode. `LEGACY` remains an explicit rollback path; this ADR defines the existing P2-03 milestone, not a new routing product.

## 1. Context and boundaries

`ROADMAP.md` assigns P2-03 to notification-preference normalization. The current external notification intake maps exactly seven event types to seven booleans on `telegram_users` through `NOTIFICATION_PREFERENCE_BY_TYPE` and `RecipientResolverService`. `PATCH /api/users/:id` changes those booleans. Both direct and persisted intake use the same resolver; persisted intake freezes recipients and dedupe identities at intent creation. Normalized `users` and `user_channels` do not contain preferences. Task reminders route to the assignee; task escalations use explicit `notification_routing_rules`. Neither is a consumer of the seven legacy booleans.

The older `docs/architecture/database-migration-plan.md` requires recipient-set comparison before a resolver cutover and a rollback path to legacy booleans. It sketches broader event/route tables, but the repository already has persisted event/intake/delivery tables and explicit task escalation rules. P2-03 must not duplicate or replace those models.

## 2. Decision and scope

Normalize storage of only the seven **existing** optional Telegram notification preferences into one row per `(telegram_user_id, notification_type)`. Keep the existing seven type-to-boolean mapping, default-false semantics, legacy response DTO, `PATCH /api/users/:id` request shape, and legacy columns. New event types, customer-defined routing, mandatory delivery, broadcast targeting, OWNER/SYSTEM_ADMIN escalation, per-channel preference editing, and a new preference UI/API are out of scope.

The legacy boolean columns remain the write authority during P2-03. A database trigger mirrors every legacy insert/update into normalized rows in the same transaction; callers never write two stores independently. A normalized resolver may become the read authority only after recipient parity is proven. Preserve old reads behind an explicit rollback switch. Do not automatically replay or re-expand persisted intents during a switch.

## 3. Schema and migration

Add exactly one forward-only migration after #21 (expected #22); migrations #1–21 remain byte-identical. Create `public.telegram_notification_preferences` with:

- `telegram_user_id bigint not null` referencing `public.telegram_users(id)`;
- `notification_type text not null` constrained to the seven existing `NotificationType` values;
- `enabled boolean not null default false`;
- primary key `(telegram_user_id, notification_type)` and a recipient-lookup index appropriate to enabled/type reads.

Use the existing deny-all RLS/service-role-only convention; no public or browser database access. In the migration transaction, backfill all seven rows for every existing Telegram user, including false values. Install an `AFTER INSERT` trigger and an `AFTER UPDATE OF` the seven preference columns trigger on `telegram_users` that upsert all seven values atomically on preference writes. Metadata-only `/start` updates should not rewrite preference rows. The trigger must not modify the legacy row, change `/start` metadata semantics, or recurse. The `telegram_users` FK is deliberately transitional: it covers registrations even before the normalized `users` bridge is materialized and makes the existing legacy ID/dedupe contract stable. Do not remove legacy columns or change the existing `users`/`user_channels` relationship.

The migration must be safe for empty and populated installations, idempotent under the repository migration runner, and verified against a disposable database. No data from the linked development or production project is required to design it.

## 4. Resolver and cutover contract

Keep the existing `RecipientResolverService` entry point and seven-key mapping. Add a normalized repository query that returns the same `TelegramUser[]` projection, selecting **distinct** legacy users where `telegram_users.active = true` and the matching normalized `(notification_type, enabled = true)` row exists. The comparison path must compare this unmasked normalized result with the legacy boolean result in **both** directions; intersecting them would hide stale enabled rows. Before `NORMALIZED` mode is authorized, database parity verification must also prove that all seven normalized rows exist and match the legacy values for every Telegram user. Preserve the legacy query's ordering/absence of ordering; compare recipient sets by stable legacy user ID, not row order.

Use one explicit server-only resolver mode: `LEGACY` (default), `COMPARE`, or `NORMALIZED`. `LEGACY` sends using the existing resolver only. `COMPARE` executes both read paths for one event and records sanitized set counts/difference counts, but sends **only** to the legacy result; no user IDs, Chat IDs, names, or message text in logs. A comparison failure must not silently switch authority or cause a second send. `NORMALIZED` sends using the normalized result only after parity approval; no per-request fallback that could silently alter recipients. Resolver mode is environment/deployment-only, not a runtime setting or browser control.

Cutover sequence: additive migration and backfill → `LEGACY` baseline → `COMPARE` with zero recipient-set differences for all seven types and realistic active/inactive/opt-out cases → explicit operator approval → `NORMALIZED`. A mismatch blocks cutover. Rollback changes only the resolver mode to `LEGACY`; preserve the normalized table, mirror trigger, event history, and delivery state. No automatic resend/replay. Removal of legacy columns or the rollback path is a later, separately approved contract/migration.

## 5. Compatibility and authorization

- `POST /api/notifications/send` input, synchronous counts, integration identity, idempotency `(source, external_event_id)`, recipient dedupe keys, fan-out, retry, and delivery accounting remain unchanged.
- Existing `GET/PATCH /api/users` legacy DTO and authorization remain unchanged. Boolean validation remains strict; no new preference writes from the browser or Telegram.
- `/start` remains metadata-only and must not reset opted-in preferences. A new registration starts with all seven disabled, as today.
- Reminder and escalation recipient resolution, explicit route rules, OWNER reports/alerts, and operational system signals are unchanged. A boolean named `owner_report` or `system_error` does not by itself authorize automatic push of a new event.
- The mirror trigger and resolver are service-role-only; preserve RLS, no public policies, and no credential or identity data in diagnostics.

## 6. Verification matrix

| ID | Required proof |
| --- | --- |
| NP-01 | Clean disposable database applies all migrations, including #22, with RLS/service-role grants intact. |
| NP-02 | Backfill yields exactly seven rows per pre-existing Telegram user and exact enabled values for all seven types. |
| NP-03 | Fresh `/start` registration creates seven disabled rows without changing reply or normalized identity bridge. |
| NP-04 | Repeated `/start` updates metadata without resetting any preference. |
| NP-05 | Legacy `PATCH /api/users/:id` boolean update mirrors atomically; invalid input or failed transaction changes neither store. |
| NP-06 | Inactive users and disabled preferences are excluded identically in both resolvers, for all seven types. |
| NP-07 | `COMPARE` records sanitized difference counts while delivering only once to the legacy set; a mismatch blocks cutover. |
| NP-08 | `NORMALIZED` returns the same recipient ID set and legacy DTO as `LEGACY` after parity, including pending/inactive users and mixed opt-ins. |
| NP-09 | Mirror failure or missing normalized row never broadens normalized delivery; query failure does not silently fall back. |
| NP-10 | Switching resolver modes does not create a second persisted intent or change `event_id`, dedupe key, synchronous counts, or retry semantics. |
| NP-11 | Rollback to `LEGACY` preserves preference writes and existing delivery/event state without replay. |
| NP-12 | Reminder/escalation routing and owner/system visibility remain independent of these optional preferences. |
| NP-13 | Historical migration hashes #1–21 and legacy HTTP/notification contract tests remain unchanged. |

At least NP-02 through NP-05 and NP-08 through NP-09 require executed disposable-PostgreSQL proof, not SQL text matching alone. Include focused service/route tests plus the full quality gates (`npm test`, typecheck, build, contract, secrets, clean migrations, migration integrity, and `git diff --check`). Never use the linked development Supabase as the disposable target.

## 7. Risks and deferred work

The primary risk is divergence between legacy booleans and normalized rows. Atomic database mirroring, comparison mode, a cutover gate, and a rollback mode mitigate it; a mismatch must be reported, not auto-repaired from a live recipient list. Two queries in comparison mode add bounded database load, so comparison is an operator-controlled phase rather than a permanent synchronous requirement. This ADR does not authorize introducing new event types, recipient strategies, customer-editable routing, destructive legacy cleanup, or new preference UX.
