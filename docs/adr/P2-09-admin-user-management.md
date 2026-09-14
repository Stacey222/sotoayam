# ADR P2-09 — Admin & User Management Foundation

Status: Implemented  
Milestone: P2-09  
Scope owner: Claude Code design -> Codex implementation -> adversarial review  
Depends on: P1-01, P1-03, P0-14, and P2-00

## 1. Decision

Sotoayam will provide a production-ready, session-only administration surface for managing administrator identities and normalized operational users. Every privileged operation resolves the logged-in human and requires that actor to be a currently effective `SYSTEM_ADMIN`.

This milestone is **P2-09** because P2-01 through P2-08 already have assigned meanings. In particular, P2-01 remains the runtime-settings and OWNER-actor-redesign milestone and is not changed by this ADR.

The implementation extends the existing Fastify route -> service -> repository architecture, P1-01 password/session machinery, normalized user model, and P2-00 effective-administrator invariant. It does not create a second identity system.

## 2. Goals

- List, search, filter, and cursor-page normalized users.
- Read a safe user detail.
- Create a login-capable administrator account atomically.
- Update a user's display name.
- Update division, role, and active state through the guarded access service.
- Grant a login credential to an existing normalized operational user.
- Grant and revoke `SYSTEM_ADMIN` with real actor attribution.
- Report the effective administrator count and whether the caller is last.
- Require a newly issued temporary password to be changed before normal admin use.
- Add a responsive Indonesian `Pengguna` dashboard view using the existing local Tabler assets and ES modules.

## 3. Non-goals

- P2-01 runtime settings, business-actor selection, or OWNER actor redesign.
- Public registration, invitations by email, password reset by email, MFA, SSO, or OAuth.
- Custom role creation or permission-grant editing.
- Deleting users or historical audit records.
- Creating Telegram users or Telegram channel rows before `/start`.
- Changing P1-01 cookie, CSRF, session expiry, login cooldown, or password hashing semantics.
- Changing P1-03 rate-limit implementation or product defaults.
- Multi-tenancy or a new frontend framework.

## 4. Baseline and terminology

An **effective SYSTEM_ADMIN** is exactly the P2-00 predicate:

1. an unrevoked `SYSTEM_ADMIN` assignment exists;
2. `users.active = true`;
3. the user's division is active; and
4. that division has `grants_system_authority = true`.

An **assigned SYSTEM_ADMIN** has an unrevoked assignment but may not currently be effective. List/detail DTOs expose both states so operators are not misled by an inactive user or division.

A user **has login** when one `admin_credentials` row exists for that user. Telegram connectivity remains independent and is represented only as a boolean derived from active channel state.

## 5. Authorization and request lifecycle

All routes in this ADR are mounted under the existing `/api/admin/users` group and must:

1. pass the centralized P1-01 administrator authentication hook;
2. require `request.adminPrincipal.kind === "session"`;
3. resolve the exact session user through `AdminActorResolver`;
4. require that actor to be a currently effective `SYSTEM_ADMIN`; and
5. apply the existing P1-03 structural admin read/write policy and P1-01 CSRF check.

The shared `ADMIN_API_KEY` fallback is rejected with `401 SESSION_REQUIRED` even when compatibility fallback is enabled. It cannot list sensitive account metadata or perform mutations in this milestone.

The actor is checked again inside privileged database RPCs where the operation changes credentials, access, or authority. This prevents a stale route-level decision from surviving an authority change that wins the transaction race.

`password_change_required` is enforced after session validation but before normal admin route handlers. A restricted session may access only:

- `GET /api/admin/auth/session`;
- `POST /api/admin/auth/password`; and
- `POST /api/admin/auth/logout`.

It cannot list/revoke sessions or access any normal admin route until the password change succeeds.

## 6. Safe user DTO

Both list and detail use an explicit mapper and allow exactly these keys:

```ts
interface AdminUserDto {
  id: number;
  display_name: string | null;
  email: string | null;
  business_user_code: string | null;
  division: null | {
    id: number;
    code: string;
    name: string;
    active: boolean;
    grants_system_authority: boolean;
  };
  role: null | {
    id: number;
    code: string;
    name: string;
    active: boolean;
  };
  active: boolean;
  telegram_connected: boolean;
  has_login: boolean;
  password_change_required: boolean;
  system_admin: boolean;
  effective_system_admin: boolean;
  is_current_user: boolean;
  created_at: string;
  updated_at: string;
}
```

No response may contain password algorithms/hashes, salts, session or CSRF material, integration credentials, raw Telegram chat/user identifiers, login-attempt rows, or internal Supabase credentials. Database rows must never be spread directly into HTTP responses.

## 7. API contract

Existing Sotoayam envelopes remain in use: successful responses contain `success: true` and `data`; failures retain the central error envelope.

### 7.1 List users

`GET /api/admin/users`

Query parameters:

| Parameter | Contract |
| --- | --- |
| `q` | Optional trimmed text, 1-120 characters; case-insensitive match against display name, login email, or business user code |
| `status` | Optional `pending`, `active`, or `inactive`; preserves the existing normalized-user status meanings |
| `division_id` | Optional positive integer |
| `system_admin` | Optional strict `true` or `false`; filters current unrevoked assignment state |
| `has_login` | Optional strict `true` or `false` |
| `limit` | Optional integer 1-100; default 25 |
| `cursor` | Optional opaque cursor returned by the previous page |

Ordering is deterministic: `created_at DESC, id DESC`. The cursor is a versioned, base64url-encoded keyset containing only the last row's `created_at` and `id`; it is validated strictly and is not a database offset.

Response:

```json
{
  "success": true,
  "data": [],
  "pagination": { "next_cursor": null }
}
```

Keeping `data` as an array preserves the existing normalized-user list response shape. `next_cursor` is non-null only when another page exists.

### 7.2 Authority summary

`GET /api/admin/users/authority-summary`

This static route must be registered so it cannot be interpreted as `/:id`.

```json
{
  "success": true,
  "data": {
    "effective_system_admins": 2,
    "you_are_last": false
  }
}
```

The count comes from the P2-00 effective predicate. `you_are_last` is true only when the caller is effective and the effective count is one. The response is informational; database mutation guards remain authoritative.

### 7.3 User detail

`GET /api/admin/users/:id`

Returns one `AdminUserDto`; unknown IDs return `404 NOT_FOUND`.

### 7.4 Create administrator account

`POST /api/admin/users`

Body:

```json
{
  "display_name": "Administrator Operasional",
  "email": "admin@example.test",
  "division_id": 1,
  "role_id": 2,
  "grant_system_admin": true,
  "reason": "Menambah administrator operasional"
}
```

Rules:

- unknown fields are rejected;
- `display_name` is trimmed and must contain 1-120 non-control characters;
- email is trimmed, lowercased, then validated by the existing administrator email rules;
- division and role must exist and be active;
- `grant_system_admin` is required and boolean;
- `reason` is required, trimmed, and 1-500 characters;
- granting authority additionally requires an authority-capable active division;
- normalized email collision returns `409 EMAIL_ALREADY_IN_USE`;
- one database transaction creates the `users` row, `admin_credentials` row, optional authority assignment, and audit rows;
- no `telegram_users` or `user_channels` row is created.

The application generates a cryptographically random 32-character base64url temporary password from 24 random bytes, checks it with `validatePasswordPolicy`, regenerates on the improbable policy collision, and hashes it using the existing scrypt implementation before invoking the RPC. The RPC receives only the hash and algorithm.

Response is `Cache-Control: no-store`:

```json
{
  "success": true,
  "data": {
    "user": {},
    "temporary_password": "returned-only-here"
  }
}
```

### 7.5 Update profile

`PATCH /api/admin/users/:id/profile`

Body contains exactly `display_name`. The change is audited with the real actor. Email editing is not part of this milestone.

### 7.6 Update access

`PATCH /api/admin/users/:id/access`

Body:

```json
{
  "division_id": 1,
  "role_id": 2,
  "active": true,
  "confirm": false,
  "reason": null
}
```

`division_id`, `role_id`, and `active` retain the existing access contract and may be omitted individually; at least one must be supplied. `confirm` and `reason` are used only for guarded self-demotion. Existing non-self callers are not forced to send them.

- self-deactivation always returns `403 SELF_DEACTIVATION_FORBIDDEN`;
- moving oneself from an effective to a non-effective authority state requires `confirm=true` and a 1-500 character reason;
- P2-00 decides atomically whether another effective administrator remains;
- deactivation revokes all live sessions for the target user in the same transaction;
- all access and session-revocation audits identify the real actor.

### 7.7 Grant login to an existing user

`POST /api/admin/users/:id/login`

Body contains `email` and `reason`. The target must exist, be active, and have no existing credential. Email normalization and temporary-password behavior are identical to account creation. Existing credentials return `409 LOGIN_ALREADY_ENABLED`; duplicate normalized email returns `409 EMAIL_ALREADY_IN_USE`.

Credential creation and audit are atomic. The response contains the safe user DTO and `temporary_password`, is marked `Cache-Control: no-store`, and never creates Telegram identity state.

### 7.8 Grant SYSTEM_ADMIN

`POST /api/admin/users/:id/system-admin`

Body contains exactly a required 1-500 character `reason`. The operation delegates to the P2-00 guarded authority service/RPC, requires an eligible active target, and writes the real actor user.

### 7.9 Revoke SYSTEM_ADMIN

`DELETE /api/admin/users/:id/system-admin`

Body contains exactly `reason` and `confirm`; `confirm` must be true. Self-revocation is permitted only when the P2-00 transaction proves another effective SYSTEM_ADMIN remains. Otherwise it returns `409 LAST_SYSTEM_ADMIN`. Immediate session invalidation follows naturally because every admin request re-evaluates current authority.

## 8. Temporary password lifecycle

- Plaintext exists only in application memory between generation and the single HTTP response.
- It is never passed to PostgreSQL, logged, audited, persisted, placed in a URL, or stored in browser storage.
- Only its existing scrypt representation is persisted.
- It is returned exactly once by the successful create/grant-login response and cannot be fetched later.
- Retrying after a committed response loss does not reveal it again; the operator must use the existing server-side reset-password recovery command.
- Both credential-issuing responses use `Cache-Control: no-store`.
- The UI presents it in a dedicated modal, prevents accidental modal dismissal, and requires an explicit “sudah disimpan” acknowledgement before clearing the DOM text. The acknowledgement is a local safety affordance, not persisted business state.

## 9. `password_change_required`

Migration #20 adds:

```sql
admin_credentials.password_change_required boolean not null default false
```

The default preserves all existing credentials and first-install/bootstrap behavior. Administrator creation and login grants set it to true.

The session validation result and `SessionPrincipal` carry the flag. Login remains allowed so the user can change the temporary password. The centralized admin boundary rejects restricted sessions with `403 PASSWORD_CHANGE_REQUIRED`, except for the explicit auth-route allowlist in §5. Successful `change_admin_password` clears the flag in the same transaction that stores the new hash and applies existing session-revocation semantics.

No client-only gate is acceptable; the UI reflects the server state but cannot enforce it by itself.

## 10. Schema and repository plan

Implementation may add exactly one forward migration, repository migration #20. Migration #19 and all earlier migrations remain byte-identical.

The migration should:

1. add `password_change_required` with the compatibility-safe default;
2. add service-role-only, `SECURITY DEFINER`, fixed-`search_path` RPCs for atomic administrator creation, login grant, and profile update where needed;
3. use `CREATE OR REPLACE` for current session validation/password-change and guarded access RPCs where their contracts must include the new flag or atomic session revocation;
4. recheck the effective actor inside privileged transactions;
5. reuse `gwens_system_admin_invariant` and the P2-00 authority functions rather than introduce a competing lock or count;
6. retain deny-all RLS and explicit service-role execution grants; and
7. write audit rows without plaintext credentials or secret-derived material.

List/detail may use explicit service-role repository selections if they remain bounded and map through the safe DTO. Cursor pagination must be executed by PostgreSQL query constraints, not by loading every user and slicing in memory.

Email uniqueness continues to rely on the existing normalized database constraint. Database unique violations are mapped deterministically to `EMAIL_ALREADY_IN_USE`.

## 11. Audit attribution

Every mutation records `actor_type = 'USER'` and the resolved session user's ID. At minimum the audit trail distinguishes:

- administrator account creation;
- login credential grant;
- profile change;
- division, role, and active-state changes;
- session revocation caused by deactivation;
- SYSTEM_ADMIN grant/revoke through the existing P2-00 actions.

Audit state may contain safe identifiers and before/after metadata, but never a password, password hash, salt, cookie, session/CSRF token, integration credential, or Telegram identifier. Historical rows are not rewritten.

## 12. Dashboard UI

The existing vanilla HTML/CSS/ES-module and local Tabler stack remains authoritative.

- Add navigation label `Pengguna` and its responsive view shell.
- Put user behavior in a new `public/users.js` module; do not continue growing `public/app.js` with the full feature.
- Provide search plus status, division, SYSTEM_ADMIN, and login filters.
- Render cursor-based “Muat lainnya” pagination without duplicate rows.
- Show safe badges: `SYSTEM_ADMIN`, `Login`, `Telegram`, and `Anda`.
- Open detail and independent profile/access/authority/login sections in an offcanvas panel.
- Provide a `Buat Administrator` modal and dedicated one-time password modal.
- Require confirmations for deactivate, grant, and revoke; require reason wherever the API does.
- Disable self-deactivation controls and show last-admin guardrails from `authority-summary`.
- Handle loading, empty, validation, `401`, `403`, `409`, and session-expiry states in Indonesian.
- Keep all mutations on the existing CSRF-aware request helper.
- Never place the temporary password or any credential in local/session storage.
- Use only local Tabler assets; no CDN, framework, or new frontend build system.

## 13. Compatibility constraints

- P2-01 retains its existing runtime-settings/OWNER-redesign definition.
- Existing legacy user and authority aliases remain available but route access mutations through the guarded service.
- Existing `/api/admin/users/catalogs` and `/api/admin/users/:id/business-user-code` contracts remain available.
- Existing normalized list consumers continue receiving an array in `data`; pagination metadata is additive.
- P1-01 session/cookie/CSRF/cooldown and password policy remain unchanged except for the explicit temporary-password gate.
- P1-03 policies remain structural; no rate-limit implementation file or default is weakened.
- P2-00 effective-administrator semantics, lock identifier, error, and concurrency behavior remain authoritative.
- No Telegram operational identity is provisioned by administrator-account creation.
- No historical migration is edited and no existing schema object is renamed or dropped.

## 14. Test matrix

| Ref | Acceptance test |
| --- | --- |
| U-01 | A session-authenticated effective SYSTEM_ADMIN can access every P2-09 endpoint with the existing CSRF rules on mutations. |
| U-02 | A session user without effective SYSTEM_ADMIN authority is rejected, including an inactive user or a user in an inactive/non-capable division. |
| U-03 | Shared `ADMIN_API_KEY` is rejected for every P2-09 endpoint while compatibility fallback is enabled. |
| U-04 | A demoted administrator cannot grant SYSTEM_ADMIN to self or another user using an existing session. |
| U-05 | List and detail return the exact safe DTO key set and never expose hashes, salts, tokens, credentials, login-attempt data, or raw Telegram identifiers. |
| U-06 | `q`, status, division, assigned-SYSTEM_ADMIN, and has-login filters compose correctly and reject invalid values. |
| U-07 | Keyset cursor pagination is deterministic, bounded, produces no duplicate rows across pages, and rejects malformed cursors. |
| U-08 | Create and grant-login normalize email with trim/lowercase; case-insensitive collision returns `409 EMAIL_ALREADY_IN_USE`. |
| U-09 | Administrator creation plus optional SYSTEM_ADMIN grant and audit is atomic; failure leaves no partial user, credential, authority, or audit effect. |
| U-10 | Temporary password is policy-valid, returned once with `Cache-Control: no-store`, persisted only as an existing scrypt hash, and absent from logs/audits/subsequent reads. |
| U-11 | Granting login to an existing active operational user is atomic and creates no `telegram_users` or `user_channels` row. |
| U-12 | A temporary-password user can log in but receives `PASSWORD_CHANGE_REQUIRED` on normal admin routes; session/password/logout remain usable, and password change clears the flag. |
| U-13 | Profile and access changes validate input, preserve P2-00, and audit the real session actor rather than SYSTEM/shared-key attribution. |
| U-14 | Self-deactivation is always rejected and does not alter the user or sessions. |
| U-15 | Self-demotion requires confirmation and reason, succeeds only with another effective SYSTEM_ADMIN, and otherwise returns `LAST_SYSTEM_ADMIN`. |
| U-16 | P2-00 regression matrix remains green: sequential mixed reductions and concurrent mutual revoke/deactivation serialize so exactly one last-admin-removing operation is refused. |
| U-17 | Deactivation revokes all target admin sessions atomically; the next request with any old token fails. |
| U-18 | `Pengguna` UI covers search/filter/load-more/detail/create/profile/access/login/authority flows, confirmation and one-time-password states, mobile sanity, and contains no browser-stored secret. |
| U-19 | Exactly 20 migrations apply twice on disposable PostgreSQL, 19 historical hashes remain unchanged, bootstrap remains compatible, route manifest/rate-limit/CSRF coverage passes, followed by the complete validation suite. |

Implementation is not complete unless U-01 through U-19 all pass.

## 15. Known risks and follow-ups

- If the one-time password response is lost after commit, it cannot be recovered; use the existing server-side password reset command. This is safer than retaining plaintext.
- Login-capable users without effective SYSTEM_ADMIN may authenticate only to change/logout and otherwise receive authorization denial. Broader administrator roles require a separate authorization product decision.
- Email editing, account deletion, invitation delivery, MFA, SSO, and credential reset UI remain out of scope.
- P2-01 still owns runtime settings and OWNER business-actor redesign.
- P2-03 still owns broader notification-preference normalization.
- A post-implementation adversarial review must inspect concurrency, temporary-password leakage, DTO key sets, and restricted-session route coverage before release.

## 16. Implementation gate

The design is implementation-ready once this ADR is referenced by repository governance. Codex must stop rather than improvise if implementation would require a second migration, a historical migration edit, a new identity model, weakening P1-01/P1-03/P2-00, or changing P2-01 scope.
