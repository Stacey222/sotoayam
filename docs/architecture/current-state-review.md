# Current-State Architecture Review

## Scope and evidence

This review is based on the repository as inspected on 2026-08-28: application source, browser assets, tests, two SQL migrations, README, environment-variable names, and the safe `check:supabase` contract. No `.env` value or production row is included here.

The repository is not a Git working tree, so branch, history, and diff provenance are unavailable. Migration files describe intended schema; only facts explicitly returned by the diagnostic command should be treated as live-schema verification.

Live-safe verification on 2026-08-28 returned:

```text
SUPABASE_ENV = PASS
SUPABASE_CONNECTION = PASS
SERVER_CREDENTIAL_ACCEPTED = true
TELEGRAM_USERS_TABLE = PASS
DIVISION_COLUMN_EXISTS = true
SERVER_WRITE = PASS
RESULT = PASS
```

The command selects the full required legacy projection and its write result includes verified exact cleanup. It does not introspect every catalog-level default, constraint name, index definition, trigger definition, or policy; those details below are migration-derived unless separately stated.

## Runtime architecture

```text
Telegram getUpdates                    n8n-compatible caller
        |                                      |
        v                                      v
   TelegramBot                     POST /api/notifications/send
        |                                      |
        +------ TelegramUsersRepository -------+
                           |
                           v
                 Supabase telegram_users
                           |
        +------------------+------------------+
        |                                     |
  GET/PATCH /api/users                 RecipientResolver
        |                                     |
  static Admin UI                      TelegramService
```

- `src/server.ts` validates configuration, starts Fastify, and conditionally starts long polling.
- `src/app.ts` wires one Supabase repository into Telegram registration, user routes, and notification routing.
- `TelegramBot` handles only `/start`; registration is an atomic upsert on `telegram_chat_id`.
- `NotificationService` resolves recipients then sends independently with `Promise.allSettled`.
- `public/` is a framework-free Admin UI consuming `/api/users`.
- The ERP file is only a future adapter boundary; there is no ERP implementation.

## Implemented capabilities

| Capability | Actual implementation |
|---|---|
| Health | `GET /health` returns `{status: "ok"}`. |
| Telegram registration | `/start`, metadata upsert, success/failure reply, safe diagnostics, long polling. |
| User administration | List/detail/update API and responsive browser UI. |
| Admin protection | Optional shared `ADMIN_API_KEY`; no user identity, session, or authorization model. |
| Internal notification API | Required `X-Internal-Api-Key`, seven fixed event types, message validation. |
| Recipient selection | `active=true` plus one fixed boolean preference column. |
| Delivery isolation | One Telegram failure does not cancel other sends. |
| Environment safety | Canonical server credential validation and `.env` ignored by Git rules. |
| Supabase diagnostics | Read/column check and reversible synthetic write with exact cleanup. |
| Tests | Health, event validation, recipient mapping, `/start` idempotency behavior, failure reply, delivery isolation, credential shape. |

## Repository dependencies

- Runtime: Node.js 20+, Fastify, `@fastify/static`, Supabase JS, dotenv.
- Development: TypeScript, tsx, Vitest.
- There is no ORM, migration runner configuration, frontend framework, queue, scheduler, or authentication provider.

## API and authorization behavior

| Surface | Protection | Data scope |
|---|---|---|
| `/health` | Public | No business data. |
| `/api/users/*` | Optional shared admin key | All `telegram_users`; no Divisi scope. |
| `/api/notifications/send` | Required internal shared key | Can target any matching user preference. |
| Static Admin UI | Public asset | API data is protected only when `ADMIN_API_KEY` is configured. |
| Supabase | Server-side credential | RLS enabled; browser never receives the server key. |

This is authentication-by-shared-secret, not identity-aware authorization. Current `role="Admin"` has no effect on API access.

## Existing schema inventory

### `public.telegram_users`

Purpose: Telegram channel registration, human profile fields, activation, coarse authorization labels, and notification preferences in one row.

| Column | Type | Null | Default | Application dependency |
|---|---|---:|---|---|
| `id` | `bigint generated always as identity` | no | identity | API path/detail key and Admin UI edit key. |
| `telegram_chat_id` | `bigint` | no | none | `/start` conflict target and Telegram delivery destination. |
| `telegram_username` | `text` | yes | none | Refreshed by `/start`, displayed in UI. |
| `telegram_first_name` | `text` | yes | none | Refreshed by `/start`, fallback display name. |
| `name` | `text` | yes | none | Admin-managed display name. |
| `division` | `text` | no | `'UNASSIGNED'` | Filters, pending state, Admin edit, validation. |
| `role` | `text` | no | `'UNASSIGNED'` | Admin edit/display only; not authorization. |
| `active` | `boolean` | no | `false` | User status and required recipient predicate. |
| `stock_alert` | `boolean` | no | `false` | `STOCK_CRITICAL` routing. |
| `purchase_alert` | `boolean` | no | `false` | `PURCHASE_RECOMMENDATION` routing. |
| `sales_alert` | `boolean` | no | `false` | `SALES_FOLLOWUP` routing. |
| `marketing_alert` | `boolean` | no | `false` | `MARKETING_ALERT` routing. |
| `content_alert` | `boolean` | no | `false` | `CONTENT_OPPORTUNITY` routing. |
| `owner_report` | `boolean` | no | `false` | `OWNER_DAILY_REPORT` routing. |
| `system_error` | `boolean` | no | `false` | `SYSTEM_ERROR` routing. |
| `created_at` | `timestamptz` | no | `now()` | Ordering and audit-lite timestamp. |
| `updated_at` | `timestamptz` | no | `now()` | Maintained by trigger. |

Constraints and indexes declared by migrations:

- Primary key: `id`.
- Unique constraint: `telegram_chat_id` (required by `onConflict`).
- Indexes: `telegram_users_active_idx`, `telegram_users_division_idx`.
- Trigger: `set_telegram_users_updated_at` before every update.
- RLS: enabled. No public policies are declared; the server credential is expected to bypass RLS.
- Foreign keys: none.

Migration history:

1. `202608260001_create_telegram_users.sql` creates the table, indexes, trigger, and enables RLS.
2. `202608270001_add_missing_telegram_users_division.sql` is an idempotent repair: add/backfill/default/`NOT NULL`/index for `division`.

Application code assumes `select('*')` returns this full shape. There are no other database tables in repository migrations.

## Coupling that constrains migration

- `DIVISIONS` and `ROLES` are duplicated in TypeScript validation and browser JavaScript.
- `TelegramUser` is simultaneously a person, Telegram channel, access profile, and route configuration.
- `TelegramUsersRepository` is shared by registration, Admin API, and notification recipient lookup.
- Pending status is inferred as `division='UNASSIGNED' AND active=false`; it is not a distinct workflow state.
- Current notification type-to-column mapping is compiled into source.
- The Admin shared key identifies no actor, so changes cannot answer who made them.

## Gap analysis

| Requirement | Status | Evidence / gap |
|---|---|---|
| Working Telegram `/start` | **SUPPORTED** | Atomic upsert, safe replies, tests, confirmed runtime. |
| Supabase diagnostic | **SUPPORTED** | Compact safe command with reversible write cleanup. |
| One home Divisi | **PARTIALLY_SUPPORTED** | One string field exists, but inactive registrations use `UNASSIGNED`; no FK/master data. |
| Dynamic Divisi lifecycle | **MISSING** | Hard-coded in backend and browser; no table or management API. |
| Extensible roles | **PARTIALLY_SUPPORTED** | String accepts migrated data, but allowed values are hard-coded and roles grant nothing. |
| Explicit permissions | **MISSING** | No permissions or enforcement service. |
| Divisi-scoped ADMIN | **CONFLICTING** | Current Admin API shared key has global access; business role is not evaluated. |
| OWNER cross-Divisi visibility | **MISSING** | No reports, permissions, or scope evaluator. |
| OWNER not auto-subscribed | **PARTIALLY_SUPPORTED** | Boolean opt-in avoids automatic sends, but model is not route policy. |
| IT technical authority | **MISSING** | IT is absent from current hard-coded Divisi list; no technical permissions. |
| Transferable `SYSTEM_ADMIN` | **MISSING** | No system authority or grant/revoke audit. |
| Task lifecycle | **MISSING** | No task tables, service, routes, or UI. |
| Traceable task sources/import batches | **MISSING** | No task/import model. |
| Cross-Divisi collaboration | **MISSING** | No rules or scope authorization. |
| Task relationships/activity/evidence | **MISSING** | No work domain. |
| Dynamic reporting/freshness | **MISSING** | No report catalog, source adapters, or freshness contract. |
| Configurable business alert policy | **MISSING** | Fixed event types/preferences; no policy, severity, materiality, dedupe, or acknowledgement. |
| High-volume aggregation | **MISSING** | Sends one message per received event; no batch/cooldown. |
| Normalized notification routing | **SHOULD_DEPRECATE** | Seven booleans are acceptable compatibility fields, not the target route model. Do not remove yet. |
| Delivery history | **MISSING** | Summary is logged only; no durable delivery record. |
| Automation events/idempotency | **PARTIALLY_SUPPORTED** | `event_id` is accepted but not stored or deduplicated. |
| Technical monitoring/incidents | **MISSING** | Only process logs and `/health`. |
| Two-layer error codes | **PARTIALLY_SUPPORTED** | Internal codes and provider diagnostics exist inconsistently; no uniform mapping. |
| Audit trail | **MISSING** | Timestamps/logs cannot reconstruct actor, before, and after. |
| Service-role isolation | **SUPPORTED** | Supabase credential remains backend-only. |

## Current risks

1. If `ADMIN_API_KEY` is absent, user management is unprotected.
2. Even when present, a shared key cannot enforce Divisi scope or attribution.
3. Service-role database access bypasses RLS, so application authorization must be explicit and exhaustively tested.
4. Hard-coded strings will drift between database, server, and browser.
5. Notification preference columns mix user choice with mandatory operational routing.
6. No durable audit, event, or delivery records exist.
7. Telegram long polling assumes only one active poller for the token.
8. Migration application state is not tracked by a repository-level deployment workflow; filenames alone do not prove live application.
