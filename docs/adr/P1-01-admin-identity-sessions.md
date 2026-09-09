# ADR P1-01 — Administrator Identity and Server-Side Sessions

## Status

Proposed — ready for implementation

Design only. No code was written, no migration was created, no infrastructure was contacted. Implementation is a separate task.

## Context

D-007 approved the target: move from a shared browser-entered admin key to real administrator identity using a password hash plus a signed HTTP-only session. Enterprise IAM/SSO is explicitly out of scope. D-017 ranks "secure login/session" as the first admin-UI capability.

Phase 0 delivered the two halves this task joins together. P0-04 centralised all admin authorization into one fail-closed scope (`src/auth/admin-authorization.ts`). P0-11/P0-12 delivered the first-administrator credential model: a real `users` row, a scrypt hash in `admin_credentials`, an active `SYSTEM_ADMIN` assignment, and a singleton bootstrap marker. P0-14 replaced literal-`IT` authority with the guarded `grants_system_authority` capability.

What is missing is the connection between them: the product has administrator *credentials* but no way to *log in with them*. Every HTTP administrator request is still authenticated by one shared secret, and the acting business identity is guessed from database state rather than derived from the caller.

The existing code already reserves the seam. `src/auth/admin-authorization.ts:12-16` carries this comment verbatim:

> Phase 1 (P1-01) extends this with real identity (adminUserId, roles, sessionId) and adds a "session" kind. Route bodies read this, never the header.

This ADR fills that seam.

## 1. Current Auth Inventory and Risks

### 1.1 What exists today

| Concern | Mechanism | Location |
| --- | --- | --- |
| HTTP admin authentication | Shared secret in `X-Admin-Api-Key`, constant-time compared | `src/auth/admin-authorization.ts:38-51` |
| Admin route protection | `defineAdminRoutes` wrapper; 12 route groups; structurally asserted | `src/auth/admin-authorization.ts:54-70`, `tests/security/admin-route-boundary.test.ts` |
| Startup secret strength | `ADMIN_API_KEY` required, minimum 32 characters | `src/config/env.ts` |
| Administrator credential | scrypt `N=32768,r=8,p=1`, 16-byte salt, 32-byte key; encoded `scrypt$N=…$salt$hash` | `src/auth/admin-password.ts:48-66` |
| Password verification | `verifyPassword` with `timingSafeEqual` | `src/auth/admin-password.ts:68-92` |
| Password policy | ≥12 chars, no control chars, rejects common passwords and email/display-name substrings | `src/auth/admin-password.ts:31-46` |
| Credential storage | `admin_credentials` (user_id PK, unique lower(email), algorithm, hash, `password_updated_at`) | `202609090001` |
| Business actor attribution | Singleton lookup: the one active `SYSTEM_ADMIN`, or the one active `OWNER` | `src/repositories/task-users.repository.ts:79-102` |
| Authority capability | Active assignment + active user/division + `grants_system_authority` | `src/auth/system-admin-capability.ts` |
| Audit trail | Append-only `audit_logs` with actor/action/object/before/after/source | `202608290001:67-79` |
| Browser key handling | `window.prompt` → `sessionStorage["gwens-admin-key"]` → request header | `public/app.js:7-18,65` |

Two facts frame everything below:

1. **`verifyPassword` is fully implemented and currently unused in production code.** It was written in P0-12 for exactly this task. The credential half of login already exists and is tested.
2. **No route reads `request.adminPrincipal` yet.** The decorator is set on every admin request and consumed by nothing. Routes instead call `options.actorResolver.resolveTrustedActor()`, which ignores the request entirely.

### 1.2 Risks in the current model

| # | Risk | Severity | Detail |
| --- | --- | --- | --- |
| R-1 | **One shared secret is the whole administrator identity** | HIGH | Every operator who administers the instance holds the same string. There is no per-person identity, no attribution, and no way to revoke one person's access without rotating the secret for everyone and redeploying `shared/.env`. |
| R-2 | **The key is typed into a browser prompt and stored in `sessionStorage`** | HIGH | `public/app.js:65`. Any XSS in the admin UI reads the full administrator credential, not a scoped session. The secret is also long-lived, so theft is permanent until manual rotation. |
| R-3 | **No session lifecycle at all** | HIGH | Nothing expires, nothing can be revoked, there is no logout, and there is no idle timeout. A stolen key works until an operator notices and redeploys. |
| R-4 | **Audit attribution is fictional** | HIGH | Every administrative action is attributed to the singleton `SYSTEM_ADMIN` regardless of who actually made the request. `audit_logs.actor_user_id` is therefore not evidence of who did anything. |
| R-5 | **The product cannot have two administrators** | HIGH | `findTrustedAdminActorUser` throws `503 TASK_ACTOR_UNAVAILABLE` unless *exactly one* active `SYSTEM_ADMIN` exists (`task-users.repository.ts:85`). Granting a second `SYSTEM_ADMIN` breaks eight route groups. The same applies to `OWNER` for reports and alerts. This is a functional as well as a security limitation. |
| R-6 | **No brute-force boundary on any credential** | MEDIUM | Nothing rate-limits `X-Admin-Api-Key` guessing. 32 characters of entropy makes online guessing impractical, so this is currently mitigated by key length rather than by design — a control that disappears the moment passwords become the front door. |
| R-7 | **No password rotation path** | MEDIUM | The bootstrap sets the only password. There is no endpoint and no CLI to change it. A disclosed password cannot be rotated without direct database surgery. |
| R-8 | **No CSRF exposure yet, but adding cookies creates one** | MEDIUM | Header-based auth is inherently CSRF-immune. Moving to cookies introduces CSRF as a *new* risk class that must be designed for, not inherited. |
| R-9 | **`trustProxy` is not configured** | MEDIUM | `src/server.ts` builds Fastify without `trustProxy`. Behind the documented reverse proxy, `request.ip` is the proxy's address, so any per-IP control collapses into a single global bucket. This must be solved before per-IP throttling means anything. |
| R-10 | **No CORS configuration** | INFO | Favourable, not a risk: the API sets no CORS headers, so it is same-origin only. This is a precondition the session design depends on and must not regress. |

## 2. Proposed P1-01 Architecture

### 2.1 Shape

**Opaque random session tokens, hashed at rest, stored in PostgreSQL, carried in a `HttpOnly` cookie.**

```
POST /api/admin/auth/login
  email + password
        │
        ├─ login gate: per-account and per-IP failure thresholds (DB-evaluated)
        ├─ credential lookup by lower(email)  ──► admin_credentials
        ├─ scrypt verifyPassword (Node)       ──► constant-time, dummy verify on unknown email
        │
        ▼
  crypto.randomBytes(32) ──► raw token          (returned to browser, never stored)
                        └──► sha256 hex         (stored in admin_sessions.token_hash)
  crypto.randomBytes(32) ──► raw CSRF token     (returned to browser in a readable cookie)
                        └──► sha256 hex         (stored in admin_sessions.csrf_token_hash)
        │
        ▼
  Set-Cookie: __Host-sotoayam_session=<raw>  HttpOnly; Secure; SameSite=Strict; Path=/
  Set-Cookie: __Host-sotoayam_csrf=<raw>                 Secure; SameSite=Strict; Path=/

Every subsequent request
        │
        ├─ read session cookie ──► sha256 ──► validate_admin_session(hash)
        │     checks: not revoked, now < expires_at, idle window, users.active
        │     touches last_seen_at (throttled)
        ├─ state-changing method? require X-CSRF-Token matching session's csrf hash
        │
        ▼
  request.adminPrincipal = { kind: "session", adminUserId, sessionId, email, displayName }
        │
        ▼
  route authorization (unchanged): permissions, hasSystemAdminCapability, authority assignment
```

### 2.2 Why opaque server-side tokens rather than signed stateless cookies

D-007 says "signed HTTP-only session". A signed stateless cookie and an opaque server-side token both satisfy the intent — an unforgeable session — but they differ on the property this product needs most:

| | Signed stateless (JWT-style) | **Opaque + server-side store (chosen)** |
| --- | --- | --- |
| Forgery resistance | Signing key | 256 bits of entropy; nothing to forge |
| **Immediate revocation** | Requires a denylist, i.e. a server-side store anyway | **Native — one row update** |
| Logout | Advisory only without a denylist | Real |
| Password-change invalidation | Needs a `pwd_changed_at` claim check | One statement |
| Secret management | New signing key to configure, rotate, and protect | **None** |
| Leak blast radius | Token contents readable | Opaque; the DB stores only a hash |
| Complexity | Refresh/rotation machinery | One table, five functions |

The deciding factor is that "logout, expiry, revocation" are explicit requirements. Any stateless design has to add a server-side denylist to honour them, at which point it is a worse version of this design with an extra signing key to protect. Postgres is already the state store for queues, leases, dedupe and retries (D-004); sessions belong there too.

**The raw token never reaches the database.** The application hashes it with SHA-256 before every call, so a database dump, a query log, or PostgREST telemetry yields only hashes. SHA-256 is correct here rather than scrypt because the input is 256 bits of uniform randomness — there is no guessable preimage to slow down.

### 2.3 Principal model

`AdminPrincipal` becomes a discriminated union in the same file that owns it today:

```ts
export type AdminPrincipal =
  | { readonly kind: "session";
      readonly adminUserId: number;
      readonly sessionId: string;
      readonly email: string;
      readonly displayName: string;
      readonly expiresAt: string; }
  | { readonly kind: "shared-api-key" };   // transitional, see §6
```

`resolveAdminPrincipal` becomes async and tries session first, then the API-key fallback. It remains the single implementation of admin credential validation and remains fail-closed by construction: if no session authenticator is configured *and* no API key is configured, every request is denied.

### 2.4 Actor attribution — the second half of the change

Authentication alone does not finish the job. Routes currently obtain their acting identity from `resolveTrustedActor()`, which resolves the singleton `SYSTEM_ADMIN` and has no idea who is calling. A new `AdminActorResolver` derives the actor from the principal:

```ts
resolveActor(principal: AdminPrincipal): Promise<TaskActor>
  ├─ kind === "session"        → load that user + role permissions; require active user,
  │                              division and role (the checks resolveTrustedActor already makes)
  └─ kind === "shared-api-key" → existing singleton lookup (deprecated branch, deleted in Stage C)
```

This is what makes `audit_logs.actor_user_id` truthful, and it removes R-5: with session attribution, a second `SYSTEM_ADMIN` no longer breaks the API.

**Owner-gated routes are deliberately not changed.** Reports and critical alerts resolve the singleton `OWNER` (`resolveOwnerActor`). Redesigning owner attribution is P2-01 and is explicitly out of scope here; the constraint for this task is to *preserve* the ADMIN/SYSTEM_ADMIN authority model. Those routes keep the singleton owner actor in both authentication modes.

That leaves one new exposure to close. Today only one administrator exists, so "anyone with the key can read owner reports" is equivalent to "the one admin can". Once sessions make a second administrator possible, a non-owner administrator could read owner-level reports through the singleton actor. **P1-01 therefore requires session-authenticated requests to owner-gated groups to additionally hold `hasSystemAdminCapability`.** That is a guard on the transitional impersonation, not a change to the OWNER model, and it costs one predicate.

### 2.5 What does not change

- The 12 admin route groups, `defineAdminRoutes`, and the structural manifest test.
- `hasSystemAdminCapability`, `system_authority_assignments`, `grants_system_authority`.
- The scrypt parameters, encoding, and password policy from P0-12.
- The bootstrap transaction, its eligibility rules, and its non-re-armable marker.
- Role and permission semantics. No new roles, no grant editing.
- Historical migrations. Nothing is edited.

## 3. Database Changes — One New Migration

File: `supabase/migrations/202609100001_create_admin_session_authentication.sql`. Additive only. Matches the runner's `^\d{12}_[a-z0-9_]+\.sql$` contract and the house conventions established by `202609090002` (RLS on, no policies, revoke from `public, anon, authenticated`, `SECURITY DEFINER` with `set search_path = ''`).

### 3.1 `admin_sessions`

```sql
create table public.admin_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references public.users (id),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  csrf_token_hash text not null check (csrf_token_hash ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_reason text check (revoked_reason is null or revoked_reason in
    ('LOGOUT', 'PASSWORD_CHANGED', 'REVOKED_BY_ADMIN', 'SUPERSEDED', 'EXPIRED_PRUNE')),
  client_ip inet,
  user_agent_digest text check (user_agent_digest is null or length(user_agent_digest) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expires_at > issued_at),
  check (revoked_at is null or revoked_at >= issued_at),
  check (revoked_at is null or revoked_reason is not null)
);

create index admin_sessions_user_live_idx
  on public.admin_sessions (user_id, expires_at desc) where revoked_at is null;
create index admin_sessions_expiry_idx on public.admin_sessions (expires_at);
```

A UUID primary key rather than the house `bigint identity` because session ids are surfaced in the "your active sessions" view and in audit rows; a sequential id would leak the instance's total login count. `gen_random_uuid()` is core PostgreSQL from 13 onward and available on Supabase.

`token_hash` is `unique`, which also provides the lookup index for the hot path.

### 3.2 `admin_login_attempts`

```sql
create table public.admin_login_attempts (
  id bigint generated always as identity primary key,
  user_id bigint references public.users (id),
  client_ip inet,
  succeeded boolean not null,
  failure_reason text check (failure_reason is null or failure_reason in
    ('UNKNOWN_EMAIL', 'BAD_PASSWORD', 'INACTIVE_USER', 'LOCKED_OUT')),
  attempted_at timestamptz not null default now(),
  check (succeeded or failure_reason is not null),
  check (not succeeded or user_id is not null)
);

create index admin_login_attempts_user_idx
  on public.admin_login_attempts (user_id, attempted_at desc) where user_id is not null;
create index admin_login_attempts_ip_idx
  on public.admin_login_attempts (client_ip, attempted_at desc) where client_ip is not null;
```

**The attempted email is never stored.** For a known account the row carries `user_id`; for an unknown email it carries `NULL` and is counted per IP only. This keeps arbitrary attacker-supplied strings out of the database entirely and removes any need for a hashing salt or a new operator-managed secret. `client_ip` uses the native `inet` type and is retained unhashed — it is the customer's own instance, the data is operationally useful when investigating an attack, and rows are pruned on a fixed retention.

### 3.3 Functions

All `security definer`, `set search_path = ''`, `revoke … from public, anon, authenticated`, `grant execute … to service_role`.

| Function | Purpose |
| --- | --- |
| `evaluate_admin_login_gate(p_user_id, p_client_ip)` | Returns `{ locked boolean, retry_after_seconds int }` from the attempt history. Known accounts use only the per-account gate; unknown emails use only the per-IP `UNKNOWN_EMAIL` gate. Called before password verification. |
| `record_admin_login_failure(p_user_id, p_client_ip, p_reason)` | Appends the attempt, writes an `ADMIN_LOGIN_FAILED` audit row, prunes attempts older than the retention window. |
| `create_admin_session(p_user_id, p_token_hash, p_csrf_token_hash, p_absolute_ttl_seconds, p_client_ip, p_user_agent_digest)` | Inserts the session, records the successful attempt, enforces the concurrent-session cap by revoking the oldest as `SUPERSEDED`, writes `ADMIN_LOGIN_SUCCEEDED`, prunes expired sessions past retention. Returns `{ session_id, issued_at, expires_at }`. |
| `validate_admin_session(p_token_hash, p_idle_timeout_seconds, p_touch_after_seconds)` | The hot path. Returns `{ session_id, user_id, email, display_name, expires_at, csrf_token_hash }` or no row. Rejects revoked, absolutely expired, idle-expired, and inactive-user sessions. Updates `last_seen_at` only when it is older than `p_touch_after_seconds`. |
| `revoke_admin_session(p_session_id, p_reason, p_actor_user_id)` | Idempotent revocation plus `ADMIN_SESSION_REVOKED` audit. |
| `revoke_admin_sessions_for_user(p_user_id, p_reason, p_actor_user_id, p_except_session_id)` | Bulk revocation; returns the count. |
| `change_admin_password(p_user_id, p_algorithm, p_hash, p_actor_user_id, p_keep_session_id)` | Updates `admin_credentials`, stamps `password_updated_at`, revokes every other session as `PASSWORD_CHANGED`, writes `ADMIN_PASSWORD_CHANGED`. Current-password verification happens in Node before the call. |
| `list_admin_sessions(p_user_id)` | Non-secret columns only, for the "your sessions" view. Never returns any hash. |

**No table grants are issued to `service_role` for either new table.** Both are RLS-enabled with no policies and all privileges revoked; every access path goes through the definer functions above, which run as the owner. A compromised PostgREST query path therefore cannot enumerate session token hashes at all. This is stricter than the repository pattern used elsewhere and is justified by the sensitivity of the contents.

All expiry arithmetic uses the database's `now()`, so application and database clock skew cannot extend a session.

### 3.4 Audit events

Written into the existing append-only `audit_logs` with `object_type = 'ADMIN_SESSION'` (or `'ADMIN_CREDENTIAL'` for password change), `source = 'admin_session_api'`:

| Action | `actor_type` | Notes |
| --- | --- | --- |
| `ADMIN_LOGIN_SUCCEEDED` | `USER` | `object_id` = session id |
| `ADMIN_LOGIN_FAILED` | `SYSTEM` | Must be `SYSTEM`: the table's own `check (actor_type <> 'USER' or actor_user_id is not null)` forbids a `USER` row without an id, and a failed login has no verified identity. Never records the attempted password or email. |
| `ADMIN_LOGIN_BLOCKED` | `SYSTEM` | Lockout threshold reached |
| `ADMIN_LOGOUT` | `USER` | |
| `ADMIN_SESSION_REVOKED` | `USER` | Includes bulk revocations, with the count in `after_state` |
| `ADMIN_PASSWORD_CHANGED` | `USER` | Never records either password |

Session expiry is deliberately *not* audited — it is a predictable, high-volume, zero-information event.

API-key fallback usage is recorded as a structured log line plus **one** audit row per process lifetime (`ADMIN_API_KEY_FALLBACK_USED`, `SYSTEM`), which is enough to prove whether the fallback is still in use before Stage C removes it, without flooding the log on every request.

The existing `sanitizeAuditState` already redacts any key matching `token`, `cookie`, `password`, `secret`, or `credential`, so the session payloads are safe by construction as well as by convention.

## 4. API Endpoints and Contracts

New route group at prefix `/api/admin/auth`. All responses use the established `{ success, data }` / `{ error: { code, message } }` envelope.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/admin/auth/login` | none (gated) | Exchange credentials for a session |
| `POST` | `/api/admin/auth/logout` | session + CSRF | Revoke the current session |
| `GET` | `/api/admin/auth/session` | session | Current principal, for UI bootstrap |
| `POST` | `/api/admin/auth/password` | session + CSRF | Change own password |
| `GET` | `/api/admin/auth/sessions` | session | List own sessions *(optional, low cost)* |
| `DELETE` | `/api/admin/auth/sessions/:id` | session + CSRF | Revoke one of own sessions *(optional)* |

**`POST /login`** — `{ "email": string, "password": string }`

- `200` → `{ success: true, data: { user_id, email, display_name, expires_at } }` plus both `Set-Cookie` headers.
- `401 INVALID_CREDENTIALS` for unknown email, wrong password, and inactive user **alike**. One code, one message, one response shape.
- `429 LOGIN_THROTTLED` with `Retry-After` when the gate is closed.
- The body is never echoed. The password never appears in logs, audit rows, or error messages.

**`POST /logout`** — `204`, cookies cleared with `Max-Age=0`. Idempotent: revoking an already-revoked or unknown session still returns `204`, so an expired tab cannot be used to probe session validity.

**`GET /session`** — `200` with the principal, or `401 SESSION_REQUIRED`. The static admin page calls this on load to decide between the login form and the console.

**`POST /password`** — `{ "current_password": string, "new_password": string }`

- Verifies the current password with `verifyPassword`, applies `validatePasswordPolicy` to the new one, then calls `change_admin_password`.
- `400 WEAK_PASSWORD` on policy failure; `401 INVALID_CREDENTIALS` on a wrong current password.
- On success every *other* session is revoked and the caller keeps working. `204`.

This route group is **not** wrapped in `defineAdminRoutes` — login must be reachable without the shared key, or the whole exercise is pointless. It gets its own scope with its own guard, and the security manifest test must be extended to assert exactly that rather than silently accepting an unprotected group.

## 5. Session Storage and Cookie Settings

### 5.1 Cookies

| | Session cookie | CSRF cookie |
| --- | --- | --- |
| Name (secure) | `__Host-sotoayam_session` | `__Host-sotoayam_csrf` |
| Name (insecure dev) | `sotoayam_session` | `sotoayam_csrf` |
| `HttpOnly` | **yes** | no — the UI must read it |
| `Secure` | yes | yes |
| `SameSite` | `Strict` | `Strict` |
| `Path` | `/` | `/` |
| `Max-Age` | **omitted** | omitted |
| `Domain` | **omitted** | omitted |

The `__Host-` prefix is the strongest available cookie binding: the browser enforces `Secure`, `Path=/`, and the absence of `Domain`, which prevents a subdomain from overwriting the session cookie. It requires HTTPS, so the name degrades automatically when `SESSION_COOKIE_SECURE=false`.

`Max-Age` is omitted on purpose, making these browser-session cookies that die when the browser closes. Server-side absolute and idle expiry remain authoritative; the cookie lifetime is a convenience for shared machines, never a security control.

`SameSite=Strict` is correct because the admin UI is same-origin with the API and there are no inbound cross-site navigations into authenticated views. This is the primary CSRF control; the token in §5.3 is defence in depth.

### 5.2 Lifetimes

| Setting | Default | Bounds | Rationale |
| --- | --- | --- | --- |
| Absolute TTL | 12 h | 15 min – 7 d | A stolen token cannot outlive one working day |
| Idle TTL | 60 min | 5 min – absolute | An unattended console self-locks |
| `last_seen_at` touch throttle | 60 s | fixed | Bounds write amplification to at most one update per minute per session |
| Concurrent sessions per user | 10 | fixed | Bounds table growth; oldest revoked as `SUPERSEDED` |
| Session row retention | 30 d after expiry | fixed | Pruned opportunistically inside `create_admin_session` |
| Login attempt retention | 30 d | fixed | Pruned opportunistically inside `record_admin_login_failure` |

**No caching of session validation.** Each authenticated request performs one round trip to validate. At administrator click rates this is negligible, and caching would defeat immediate revocation — the property that justified this design in the first place. If measurement ever shows it matters, the answer is a bounded positive cache measured in seconds, not a redesign.

### 5.3 CSRF

A per-session synchronizer token, delivered through a readable cookie:

1. At login the server generates 32 random bytes, stores `sha256(token)` in `admin_sessions.csrf_token_hash`, and returns the raw value in the non-`HttpOnly` CSRF cookie.
2. The UI reads the cookie and sends it as `X-CSRF-Token` on every `POST`, `PUT`, `PATCH`, and `DELETE`.
3. The server compares `sha256(header)` against the session's stored hash with a constant-time comparison.
4. `GET` and `HEAD` are exempt and must remain side-effect free.

Storing the hash rather than the raw value makes this a synchronizer token bound to the session, which is strictly stronger than a plain double-submit cookie: an attacker who can set cookies still cannot produce a value matching the victim's session row.

**Login CSRF is an accepted residual.** Protecting the login form itself would require a pre-session token exchange. With `SameSite=Strict`, a same-origin-only API, and a single-administrator instance, the realistic impact — an attacker causing a victim to be logged into the attacker's account — is negligible. Recorded, not mitigated.

### 5.4 Deployment dependencies

Two existing gaps must be closed for these controls to be real:

- **TLS is a prerequisite.** `Secure` cookies are not sent over plain HTTP. `SESSION_COOKIE_SECURE` defaults to `true`, and the config must **refuse** `false` unless `HOST` is loopback and `TRUST_PROXY=false`. Reverse-proxy/TLS guidance is P3-06; this ADR makes it a hard prerequisite for production session auth rather than a later nicety.
- **`trustProxy` must be configurable.** Fastify is built without it (`src/server.ts`), so behind the documented proxy every client shares one `request.ip`. Add a `TRUST_PROXY` setting (default `false`). The implemented gate selects exactly one throttle dimension after credential lookup: known accounts use five consecutive per-account `BAD_PASSWORD`/`INACTIVE_USER` failures in 15 minutes, while unknown emails use 50 per-IP `UNKNOWN_EMAIL` failures in 15 minutes. If proxy trust is disabled behind a proxy, the unknown-email bucket becomes global, but it cannot close a known account gate; per-account lockout remains the primary password-guessing control.

### 5.5 New configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `SESSION_ABSOLUTE_TTL_SECONDS` | `43200` | Validated range |
| `SESSION_IDLE_TTL_SECONDS` | `3600` | Must be ≤ absolute |
| `SESSION_COOKIE_SECURE` | `true` | `false` only for loopback development with `TRUST_PROXY=false` |
| `TRUST_PROXY` | `false` | Set `true` behind the documented reverse proxy |
| `ADMIN_API_KEY_FALLBACK_ENABLED` | `true` | Flips to `false` by default in Stage B |

Lockout thresholds are deliberately **not** configurable — they are constants in one module. Exposing them invites the misconfiguration that disables the control.

One new production dependency: **`@fastify/cookie`**. Cookie parsing and `Set-Cookie` serialisation have enough encoding and attribute edge cases that hand-rolling them on a security path is not worth saving one small, official, widely-audited plugin. This is the only addition; no session-store library, no auth framework.

## 6. ADMIN_API_KEY Compatibility and Deprecation

The key is not removed in P1-01. Three concrete things still depend on it, and each has to be retired before it can go.

| Dependency | Retired by |
| --- | --- |
| Owner-gated reports and alerts for a non-OWNER administrator | P2-01 owner-actor redesign |
| Machine/automation callers of admin routes | P1-04 per-integration credentials (D-009) |
| Break-glass access when no administrator can log in | The password-reset CLI below |

### Stages

**Stage A — P1-01 ships.** Both mechanisms are accepted by the one `resolveAdminPrincipal`. Session is tried first; the API key is the fallback. `ADMIN_API_KEY` stays *required* at startup with its 32-character minimum, so no existing deployment breaks and no current guarantee is weakened. The browser UI stops using the key entirely and switches to login. Fallback use is logged and audited once per process.

**Stage B — after the UI migration is confirmed.** `ADMIN_API_KEY_FALLBACK_ENABLED` defaults to `false`. `ADMIN_API_KEY` becomes optional at startup. Deployments that still need the fallback opt in explicitly and visibly.

**Stage C — after P1-04.** The fallback branch is deleted from `resolveAdminPrincipal`, `AdminPrincipal` collapses to the session variant, the singleton branch of `AdminActorResolver` is deleted, and `ADMIN_API_KEY` is removed from configuration and documentation. `public/app.js`'s `gwens-admin-key` storage key disappears with it — a legacy identifier retired by planned migration rather than by blind rename, satisfying D-013.

### Break-glass recovery

Retaining an HTTP super-key as the recovery path is precisely the thing this ADR is trying to remove. Recovery belongs at the same trust level as `npm run setup` — on the server, as the service account:

```
npm run admin:reset-password -- --email <address>
```

It reuses `validatePasswordPolicy` and `hashPassword`, prompts with no echo, calls `change_admin_password`, revokes every session for that user, and writes an audit row. It is not reachable over HTTP at all. With this in place, the API key has no remaining unique capability and Stage C becomes a deletion rather than a redesign.

## 7. Threat Model and Abuse Cases

| # | Abuse case | Outcome | Control |
| --- | --- | --- | --- |
| T-1 | Online password guessing | Throttled, then locked | Known accounts: 5 consecutive account failures / 15 min; unknown emails: 50 failures per IP / 15 min; bounded cooldown; scrypt cost |
| T-2 | Offline cracking after a database dump | Expensive | scrypt `N=32768,r=8,p=1`, per-credential 16-byte salt, ≥12-character policy |
| T-3 | User enumeration through login | Not possible | One `INVALID_CREDENTIALS` code for unknown email, wrong password, and inactive user; a dummy scrypt verify runs on unknown emails so response time does not distinguish them |
| T-4 | Session token theft via XSS | Token not reachable from JS | `HttpOnly`; the CSRF cookie is readable but useless without the session cookie |
| T-5 | Session token theft from the database | Useless | Only SHA-256 hashes are stored; the raw token never crosses the DB boundary |
| T-6 | Token theft in transit | Blocked | `Secure` cookie; TLS a documented prerequisite; `SESSION_COOKIE_SECURE=false` refused off loopback or when `TRUST_PROXY=true` |
| T-7 | CSRF on a state-changing route | Blocked twice | `SameSite=Strict`; per-session synchronizer token compared constant-time |
| T-8 | Session fixation | Not possible | Tokens are generated server-side at login only; a client-supplied session identifier is never honoured |
| T-9 | Stolen token used after the victim logs out | Rejected | `revoked_at` checked on every validation; no cache |
| T-10 | Stolen token used after a password change | Rejected | `change_admin_password` revokes all other sessions |
| T-11 | Stolen token used indefinitely | Bounded | 12 h absolute plus 60 min idle, both evaluated with database time |
| T-12 | Access retained after the account is deactivated | Rejected | `validate_admin_session` requires `users.active` |
| T-13 | Authority revoked mid-session | Rejected | Route authorization re-evaluates the authority assignment and capability on every request |
| T-14 | Attacker locks out the only administrator | Bounded, not permanent | Cooldown rather than permanent lock; per-IP thresholds set high; the reset CLI is never subject to lockout |
| T-15 | Subdomain or sibling app overwrites the session cookie | Blocked | `__Host-` prefix forbids `Domain` and enforces `Path=/` |
| T-16 | Cross-origin JS reads admin responses | Blocked | No CORS headers are sent; this must not regress |
| T-17 | Privilege escalation by forging a principal | Not possible | `AdminPrincipal` is constructed only inside `resolveAdminPrincipal`; the manifest test keeps credential handling in one file |
| T-18 | Session table growth as a denial of service | Bounded | 10 concurrent sessions per user; opportunistic pruning; attempts pruned on retention |
| T-19 | Timing oracle on token lookup | Not exploitable | 256-bit tokens; an indexed equality on a hash gives no useful partial-match signal |
| T-20 | Secrets leaking into audit rows or logs | Blocked | Raw tokens and passwords are never passed to audit writers; `sanitizeAuditState` redacts `token`/`cookie`/`password`/`secret`/`credential` keys |
| T-21 | Replay against a different instance | Fails | Tokens are rows in that instance's database; there is no portable claim |

## 8. Tests and Acceptance Criteria

### Required tests

| Ref | Test |
| --- | --- |
| A | Login with correct credentials returns 200, sets both cookies with the exact expected attributes, and creates exactly one session row |
| B | Unknown email, wrong password, and inactive user all return an identical `401 INVALID_CREDENTIALS` body and shape |
| C | Unknown-email login performs a dummy verify — response times for unknown-email and wrong-password are statistically indistinguishable |
| D | The raw session token never appears in any database row, audit row, or log line; only its SHA-256 hash is stored |
| E | An authenticated request with a valid session cookie succeeds and populates `request.adminPrincipal` with `kind: "session"` and the correct `adminUserId` |
| F | A request with no cookie and no API key is denied 401 by every one of the 12 admin route groups (extends the existing SEC-001 regression table) |
| G | A revoked session is rejected on the very next request — no cache window |
| H | An absolutely expired session is rejected; an idle-expired session is rejected; a session inside both windows succeeds |
| I | `last_seen_at` is updated at most once per throttle interval |
| J | Logout revokes the session, clears both cookies, and is idempotent |
| K | State-changing requests without `X-CSRF-Token`, or with a mismatched one, are rejected 403; `GET` is unaffected |
| L | Password change revokes every other session, keeps the caller's, and rejects a wrong current password |
| M | After a password change, a token captured beforehand is rejected |
| N | Deactivating the user invalidates live sessions on the next request |
| O | Per-account lockout engages after the threshold and releases after the cooldown; the reset CLI is unaffected by lockout |
| P | Per-IP throttling engages; with `TRUST_PROXY=false` it degrades to a global bucket **without** locking out a legitimate administrator |
| Q | The concurrent-session cap revokes the oldest session as `SUPERSEDED` |
| R | Audit rows are written for login success, login failure, logout, revocation and password change, with `actor_type = 'SYSTEM'` for failures and no credential material in any payload |
| S | API-key fallback still authenticates every admin group while enabled, and is refused when `ADMIN_API_KEY_FALLBACK_ENABLED=false` |
| T | With a session principal, `AdminActorResolver` returns the session user — not the singleton — and audit attribution matches the logged-in user |
| U | **Two active `SYSTEM_ADMIN` users no longer break the API under session auth** (the R-5 regression) |
| V | A session-authenticated non-system-admin is refused by owner-gated groups (§2.4 guard) |
| W | `SESSION_COOKIE_SECURE=false` is refused at startup unless `HOST` is loopback and `TRUST_PROXY=false` |
| X | The security manifest still holds: 12 admin groups are admin scopes, the auth group is its own explicitly-asserted scope, and `x-admin-api-key` plus the session cookie names appear in exactly one source file each |
| Y | All 16 migrations apply to a clean PostgreSQL; the 15 historical hashes are unchanged |
| Z | Full suite, typecheck, build, contract tests, secret scan, and `git diff --check` are green |

### Acceptance criteria

1. An administrator can log in with the email and password created by `npm run setup`, use every admin route group, and log out.
2. The browser never receives, stores, or sends `ADMIN_API_KEY`; `sessionStorage` no longer holds a credential.
3. Sessions expire absolutely and on idle, and revocation takes effect on the next request with no cache window.
4. `audit_logs.actor_user_id` identifies the human who acted for every session-authenticated request.
5. Two `SYSTEM_ADMIN` administrators can coexist without the 503 that exists today.
6. No historical migration is modified; exactly one new migration is added.
7. The API-key path still works for every admin group while the fallback is enabled, and its use is observable.
8. A password can be changed over HTTP and reset from the server without database surgery.
9. Every test above passes, plus the full existing suite unchanged in intent.

## 9. Implementation Plan for Codex

Ordered so that each step is independently reviewable and the application stays green throughout.

1. **Migration.** Author `202609100001_create_admin_session_authentication.sql` with both tables, indexes, the eight functions, RLS, revokes, and grants. Verify against disposable local PostgreSQL only. Confirm the 15 historical hashes are untouched.
2. **Config.** Add the five settings from §5.5 with validation, including the loopback guard on `SESSION_COOKIE_SECURE` and the `TRUST_PROXY` wiring in `src/server.ts`.
3. **Repository.** `src/repositories/admin-session.repository.ts` wrapping the RPCs, and a credential-lookup-by-email method (none exists today). No direct table access.
4. **Session module.** `src/auth/admin-session.ts` — token generation, SHA-256 hashing, cookie names and attribute construction, CSRF comparison. This file and `admin-authorization.ts` are the only places cookie names may appear.
5. **Service.** `src/services/admin-authentication.service.ts` — login (gate, credential lookup, dummy verify on miss, `verifyPassword`, session creation), logout, password change, session listing.
6. **Principal.** Extend `AdminPrincipal` to the union, make `resolveAdminPrincipal` async with session-first/API-key-fallback ordering, and add the CSRF check for state-changing methods inside `defineAdminRoutes`. Keep the fail-closed default.
7. **Actor resolution.** Add `AdminActorResolver.resolveActor(principal)` with both branches, then update the eight route groups that call `resolveTrustedActor()` — a mechanical one-line change each. Add the §2.4 capability guard to owner-gated groups.
8. **Routes.** `src/routes/admin-auth.routes.ts` with its own scope, registered in `src/app.ts`. Extend the security manifest test to assert this group is deliberately not an admin-key scope.
9. **CLI.** `npm run admin:reset-password`, mirroring the existing setup CLI's no-echo prompt and redaction guarantees.
10. **UI.** Replace the admin-key prompt in `public/app.js` with a login form, `GET /session` bootstrap, CSRF header on writes, and a logout control. Keep it minimal — the full login UI is P3-01.
11. **Tests.** Implement A–Z from §8, extending rather than replacing the SEC-001 regression table.
12. **Docs.** Update `docs/deployment/clean-install.md` (login replaces the shared key for daily use), `.env.example`, `README.md`, and `docs/architecture/authorization-model.md`. Record the D-007 realisation and the deprecation stages in `DECISIONS.md`.

### Stop conditions

Stop and return for architecture review if: a historical migration would need editing; session validation cannot be made immediate-revocation-correct without caching; the CSRF control cannot be added without breaking an existing route contract; `resolveAdminPrincipal` would need to stop being the single credential validator; the API-key fallback cannot be preserved for all 12 groups; or owner-actor semantics would have to change to make anything work.

### Explicitly out of scope

OAuth/SSO, MFA, password reset by email, account lockout notification, general HTTP rate limiting (P1-03), per-integration credentials (P1-04), owner-actor redesign (P2-01), custom roles or grant editing, multi-tenancy, and the full login UI (P3-01).

## 10. Verdict

**GO.**

Nothing blocks implementation. The credential model, the password verifier, the centralised fail-closed guard, the audit table, and the principal seam all already exist; this task connects them and adds one table, one companion table, eight functions, and one route group.

Two sequencing dependencies must be carried into implementation rather than discovered during it:

1. **TLS in front of the application is a prerequisite** for `Secure` cookies. P3-06 owns the guidance; P1-01 must state the requirement and refuse insecure cookies off loopback or whenever proxy trust is enabled.
2. **`trustProxy` must be configured** before per-IP throttling is meaningful. The IP bucket applies only to unknown-email attempts; known accounts use their independent per-account gate, so a shared application-visible IP cannot lock a legitimate account through unknown-email traffic.

One deliberate scope boundary is recorded rather than solved: owner-gated reports and alerts keep the singleton `OWNER` actor, so a session-authenticated administrator still acts as that owner on those routes. The §2.4 capability guard prevents this from becoming a new escalation path once multiple administrators exist, and P2-01 removes it properly.
