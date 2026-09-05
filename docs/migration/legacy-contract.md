# Legacy Compatibility Contract v1

> **LEGACY COMPATIBILITY CONTRACT:** This freezes current observable behavior for migration comparison. It does not approve the legacy physical model as the target architecture.

## Telegram registration

Input: a Telegram message matching `/start`, including `/start@botname` and optional trailing arguments.

Required behavior:

1. Polling receives the update and invokes the handler.
2. The handler reads Chat ID and nullable username/first name.
3. Repository upserts on `telegram_chat_id`.
4. New records rely on database defaults: `division=UNASSIGNED`, `role=UNASSIGNED`, `active=false`, notification booleans false.
5. Repeated `/start` does not create a duplicate and refreshes only Telegram username/first name.
6. Repeated `/start` does not reset name, Divisi, Role, activation, or any notification preference.
7. Successful registration sends the established Indonesian success message.
8. Database failure is logged with sanitized diagnostics and sends the established generic fallback when Telegram remains available.
9. Automated tests never call the real Telegram API.

## Admin API

### `GET /api/users`

- When `ADMIN_API_KEY` is configured, `X-Admin-Api-Key` is required and compared securely.
- Returns `{success:true,data:[...]}` in the current `TelegramUser` shape.
- Filters: `status=pending|active|inactive`, valid current `division`, and `active=true|false`.
- Pending means `division=UNASSIGNED AND active=false`.
- Active means `active=true`.
- Inactive means `active=false AND division!=UNASSIGNED`.

### `GET /api/users/:id`

- Requires a positive integer ID and returns 404 when absent.

### `PATCH /api/users/:id`

- Allows only `name`, `division`, `role`, `active`, and the seven legacy preference booleans.
- Rejects `telegram_chat_id` and every unknown field.
- Validates current hard-coded Divisi/Role values and boolean types.
- Does not expose stack traces or database credentials.

The current shared Admin key is transitional authentication and has no actor identity or Divisi scope. Future authorization must preserve response compatibility while it is replaced.

## Internal notification API

### `POST /api/notifications/send`

- Requires header `X-Internal-Api-Key`; missing or incorrect key returns 401.
- Requires a known `type` and a non-empty trimmed message no longer than 4096 characters.
- Optional stable `event_id` is persisted and deduplicated. Retrying the same ID re-attempts only deliveries that are pending, and a reused ID with different type or message is rejected.
- Optional `metadata` must be an object.

Legacy event mapping:

| Event type | Boolean field |
|---|---|
| `STOCK_CRITICAL` | `stock_alert` |
| `PURCHASE_RECOMMENDATION` | `purchase_alert` |
| `SALES_FOLLOWUP` | `sales_alert` |
| `MARKETING_ALERT` | `marketing_alert` |
| `CONTENT_OPPORTUNITY` | `content_alert` |
| `OWNER_DAILY_REPORT` | `owner_report` |
| `SYSTEM_ERROR` | `system_error` |

Recipients must satisfy `active=true` and the mapped preference boolean. Delivery attempts use every matching `telegram_chat_id`; one failed send does not prevent other attempts. Response counts include `recipients`, `requested`, `sent`, and `failed`; partial failure returns `success=false` without cancelling the batch.

The seven columns are explicitly legacy routing compatibility fields. A later normalized resolver must run parity comparison before cutover.

## Error contract

Client errors use:

```json
{
  "success": false,
  "error": { "code": "...", "message": "..." }
}
```

No stack trace, environment value, credential, authorization header, secret-bearing URL, or unsafe provider payload may be returned. Telegram database logs redact tokens, Supabase keys, JWTs, and long numeric identifiers from provider diagnostics.

## Environment contract

Canonical names:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
TELEGRAM_BOT_TOKEN
INTERNAL_API_KEY
ADMIN_API_KEY
PORT
TELEGRAM_POLLING_ENABLED
LOG_LEVEL
```

`SUPABASE_SERVICE_KEY` remains a compatibility alias in `loadConfig`; canonical configuration and `.env.example` use `SUPABASE_SERVICE_ROLE_KEY`. No new alias is introduced by Slice 0.

Defaults:

- `PORT=3000` when omitted.
- Telegram polling is enabled unless `TELEGRAM_POLLING_ENABLED` is exactly `false`.
- `LOG_LEVEL=info` when omitted.
- `ADMIN_API_KEY` is optional in current runtime, which is a known security limitation.

## Static Admin UI

- Loads `/api/users`, supports All/Pending/Active/Inactive filters, and edits the same allowed fields.
- Stores an entered Admin key only in tab `sessionStorage`.
- Never receives the Supabase server credential.
- Current Divisi, Role, and preference choices remain unchanged in Slice 0.

## Health and diagnostics

- `GET /health` returns `{status:"ok"}`.
- `npm run check:supabase` must remain secret-safe and remove its exact diagnostic row.
- `npm run check:schema` verifies required legacy table/column projections without returning business rows.

## Contract ownership

Any intentional change to this document requires its contract tests, migration compatibility plan, and version to change in the same reviewed slice. Accidental deviations fail the migration baseline command.
