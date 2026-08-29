# Normalized Identity (Slice 2)

## Legacy field ownership

`telegram_users` remains the authoritative legacy read model during Slice 2.

| Responsibility | Legacy fields |
| --- | --- |
| Human identity | `name`, `telegram_first_name` as a fallback display name, `active` lifecycle |
| Telegram channel | `telegram_chat_id`, `telegram_username`, `telegram_first_name` metadata |
| Business authorization | `division`, `role`, `active` access gate |
| Legacy notification routing | `stock_alert`, `purchase_alert`, `sales_alert`, `marketing_alert`, `content_alert`, `owner_report`, `system_error` |

Notification preferences are intentionally not normalized in this slice.

## `users`

`users` represents a person independently from Telegram. It stores a nullable display name, nullable home `division_id`, nullable `role_id`, active lifecycle, timestamps, and a unique transitional `legacy_telegram_user_id` bridge. It contains no chat ID, username, channel metadata, or routing booleans.

Pending onboarding uses nullable Divisi/role references instead of fake `UNASSIGNED` catalog values. An active normalized user must have both assignments. The legacy bridge makes backfill and reconciliation deterministic and should be removed only after the compatibility window and a separately approved cutover.

## `user_channels`

`user_channels` owns communication identity. Slice 2 supports constrained `TELEGRAM`; later channel types can be added through forward migrations. `external_id` is text so the model is not tied to Telegram's numeric representation. `(channel_type, external_id)` is unique. Channel metadata never grants business authority and contains no notification preferences.

## Mapping and backfill

Legacy Divisi/role values use an explicit allowlist. `UNASSIGNED` becomes nullable references. Unsupported values or duplicate Telegram identities raise and stop the migration. The backfill uses stable legacy IDs and channel identities with conflict handling, making it resumable and idempotent without changing `telegram_users`.

## Atomic Telegram compatibility write

The server-only `register_telegram_identity` database function performs the legacy registration write and normalized synchronization in one transaction. It is executable only by `service_role`; RLS remains enabled with no public policies. Existing normalized Divisi, role, active state, display name, and channel active state are not reset by repeated `/start` calls.

If normalized synchronization fails, PostgreSQL rolls back the legacy write too. The handler logs a sanitized failure and returns the established generic registration error. This preserves consistency, makes failure visible, and prevents silent partial state. Reconciliation remains the independent detector for drift.

## Admin compatibility

The Admin API remains legacy-only in Slice 2 to preserve its public contract and minimize cutover risk. Admin changes after the backfill can temporarily create reconciliation drift until a dedicated transactional Admin compatibility write is added. Notification reads and routing also remain entirely legacy.

## Audit and SYSTEM_ADMIN

Backfill records `USER_BACKFILLED` and `CHANNEL_LINKED`. New Telegram identities record bounded `USER_CREATED` and `CHANNEL_LINKED` events without Telegram identifiers in payloads. Harmless username refreshes are not audited.

Normalized foreign keys make SYSTEM_ADMIN assignment structurally ready, but no assignment is inferred or created. Candidate reporting is count-only and explicit authorization is required in a later checkpoint.
