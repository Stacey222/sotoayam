# Sotoayam Migration Baseline v1

## Checkpoint identity

- Date: 2026-08-29 (Asia/Jakarta).
- Baseline commit: the single local commit containing this document, with historical subject `chore: establish gwens automation baseline`; the subject is immutable Git history and remains a legacy compatibility reference.
- Resolve immutable SHA: `git rev-parse HEAD`.
- No remote is created or modified by this baseline.

A commit cannot contain its own computed SHA without changing that SHA. Therefore the committed document identifies the checkpoint by its unique baseline subject and position; the actual immutable SHA is recorded in the Slice 0 completion report and obtained by the command above.

## Toolchain and package state

- Verified local toolchain: Node.js `v22.14.0`, npm `10.9.2`; project requirement remains Node.js 20 or newer.
- Runtime: Fastify, Supabase JS, dotenv, static Admin UI, Telegram Bot API through native fetch.
- Tests/build: TypeScript, tsx, Vitest.
- Exact dependency resolution: `package-lock.json` in the baseline commit.

## Existing migrations

| File | Repository purpose | Registry certainty |
|---|---|---|
| `202608260001_create_telegram_users.sql` | Legacy table, indexes, trigger, RLS | Resulting schema is live-compatible; migration-history row not independently verified. |
| `202608270001_add_missing_telegram_users_division.sql` | Forward repair for `division` | `division` is live-verified; migration-history row not independently verified. |

## Frozen runtime contracts

- Telegram `/start` registration, repeat idempotency, metadata-only refresh, success/fallback messages.
- Admin user list/detail/update shape, validation, and configured shared-key protection.
- Internal notification endpoint authentication and validation.
- Seven legacy event-to-boolean recipient mappings.
- Active/preference predicates and per-recipient delivery isolation.
- Centralized secret-safe client/database errors.
- Canonical environment names and currently supported alias.
- Health endpoint, Admin UI behavior, Supabase diagnostic.

The normative contract is `docs/migration/legacy-contract.md`; executable coverage is in `tests/contracts/`.

## Schema assumptions

- Machine-readable contract: `tests/fixtures/legacy-schema-contract.json`.
- Required table/column projections are safe-live-verifiable.
- Primary key, unique constraint, indexes, defaults, trigger, and RLS are migration-defined.
- REST diagnostics do not pretend to verify catalog metadata that is unavailable; those states are `NOT_VERIFIED`.

## Known legacy debt

- `telegram_users` mixes identity, channel, authorization labels, activation, and routing.
- Shared `ADMIN_API_KEY` is transitional authentication with no actor identity or Divisi scope.
- Seven notification booleans are legacy routing, not the target normalized policy.
- Service-role database access depends heavily on application-side authorization.
- Divisi and Role options are duplicated/hard-coded in server and browser.
- There is no durable audit, event idempotency, delivery history, or migration registry workflow.

## Recorded future business decisions (not implemented)

- One active business Role per user: initial `STAFF`, `ADMIN`, `OWNER`; future Roles may be added dynamically.
- `SYSTEM_ADMIN` is separate from business Role and never bound to a Telegram identifier.
- Initial conceptual technical operator: home Divisi IT, business Role ADMIN, separate SYSTEM_ADMIN authority.
- Handover order: assign replacement, verify replacement, revoke previous authority, audit every operation; never leave zero active SYSTEM_ADMIN.
- Cross-Divisi default is DENY. `ONPAGE_B2C -> CONTENT_CREATOR` is the confirmed collaboration; other proposals remain inactive.
- Requesting Divisi may see SHARED progress/activity but not INTERNAL target-Divisi notes.
- First planned real report after task foundation: `CONTENT_CREATOR -> AFFILIATE_TASK_STATUS`, sourced from the Sotoayam Task System.

## Rollback boundary

```text
source rollback -> this Git baseline commit
runtime rollback -> current telegram_users repository and legacy route behavior
future additive rollback -> disable new path, return to legacy, retain additive tables for diagnosis
```

No database drop, truncate, reset, or destructive rollback is part of this checkpoint.

## Next migration boundary

Slice 1 may add Divisi, Role, Permission, SYSTEM_ADMIN-governance, and audit foundation tables only after this baseline command is green. It must not switch current runtime authority or registration paths in the same slice.
