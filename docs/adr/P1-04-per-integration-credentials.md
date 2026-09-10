# P1-04 — Per-Integration Machine Credentials

Status: Implemented
Owner: Claude Code architecture -> Codex implementation
Realizes: D-009 (integration credentials), D-008 (integration boundary)
Depends on: P1-01 (`docs/adr/P1-01-admin-identity-sessions.md`), P1-03 (`docs/adr/P1-03-rate-limiting.md`)
Constrained by: D-002 (one instance per customer), D-003 (one small VPS), D-004 (no Redis), D-014 (additive migrations)

## 1. Problem

Two shared secrets currently stand in for every machine identity in the product.

`INTERNAL_API_KEY` is a single process-wide string compared with `secureEqual` in
`notifications.routes.ts` and in the `internalTaskIngestionRoutes` preHandler. Every integration
that exists — today's n8n, tomorrow's ERP adapter — presents the same value. It cannot be rotated
for one caller without rotating it for all, cannot be revoked for one caller at all, and reveals
nothing about who called.

On top of that, `/api/internal/tasks` derives *which* integration is acting from a caller-supplied
`X-Integration-Code` header:

```ts
const integration = await options.integrations.findActiveByCode(rawCode.trim().toUpperCase());
```

Any holder of `INTERNAL_API_KEY` can therefore claim to be any registered integration, inherit its
`requesting_division_id`, and act with its `TASK_CREATE` capability. The integration code is doing
identity work it was never designed to bear. D-009 names this exactly: *a caller-provided
integration code must not be the sole identity assertion.*

The `task_source_integrations` table already anticipated this. Its own comment reads:

> `'Trusted server-side task origins. Credentials are never stored in this table.'`

P1-04 supplies the credentials that comment is waiting for.

`ADMIN_API_KEY` is the third shared secret. P1-01 left it as an observable Stage A fallback and
tied its staged removal to this ADR (§7).

## 2. Decision summary

D-P1-04-A. Every machine integration gets its own credential: a **selector + secret** pair, where
the secret is 256 bits of CSPRNG entropy stored **only** as a SHA-256 digest.

D-P1-04-B. **SHA-256, not scrypt.** Password hashing exists to make low-entropy guesses expensive;
against a 256-bit random secret there is nothing to slow down. Applying scrypt to a
machine-to-machine hot path would add ~50–100 ms and ~32 MB per request — the exact
memory-exhaustion vector P1-03 §14 T-2 was designed to prevent, self-inflicted. This is the same
reasoning P1-01 already applied to session tokens, and the same reasoning that makes scrypt
correct for human passwords and wrong here.

D-P1-04-C. The **selector** makes lookup practical without plaintext: an indexed, public,
non-secret handle that resolves one row in O(1), after which the digest is compared. No table
scan, no plaintext, no reversible storage.

D-P1-04-D. The integration code stops being an identity assertion. Identity comes from the
credential alone. A supplied `X-Integration-Code` is accepted only as an optional consistency
assertion that must *agree* with the authenticated integration.

D-P1-04-E. Credentials are validated through a SECURITY DEFINER RPC on **every** request with no
in-process caching, so revocation is immediate — the same guarantee P1-01 gives sessions.

D-P1-04-F. Machine credentials get **no lockout**. A per-credential cooldown would let an attacker
disable a customer's production automation by sending garbage. Volume is bounded by P1-03 instead.

D-P1-04-G. One additive migration. No historical migration is touched, and `audit_logs` needs no
new `actor_type`.

## 3. Credential format

```
soto_ik_<selector>_<secret>
        └16 chars┘ └─43 chars─┘

soto_ik_<16-character-selector>_<43-character-secret>
```

| Part | Value | Secret? |
|---|---|---|
| `soto_ik_` | Fixed literal prefix | No |
| `<selector>` | 16 chars Crockford base32 lowercase (`0-9 a-h j k m n p-t v-z`), from `randomBytes(10)` = **80 bits** | No — public identifier |
| `<secret>` | 43 chars base64url, from `randomBytes(32)` = **256 bits** | Yes |

The literal prefix exists so the credential is **greppable**. `scripts/check-secrets.ts` gains a
`soto_ik_` pattern, and third-party secret scanners can recognise a leaked Sotoayam credential in
a repository, a log, or a paste. A credential with no distinguishing shape is a credential nobody
notices leaking.

The selector is deliberately *not* the integration code. Codes are guessable business words
(`ACME_N8N`); selectors are 80 random bits. A public identifier that is also enumerable would hand
an attacker the list of live credentials.

**What clients send** — one header:

```http
POST /api/internal/tasks
X-Integration-Key: soto_ik_<selector>_<secret>
```

A dedicated header matches the existing `x-admin-api-key` / `x-internal-api-key` convention, is
trivial to set in n8n, and avoids overloading `Authorization` (which must stay free for any future
scheme). Exactly one transport is supported; no query-parameter form is offered, because query
strings land in proxy access logs.

## 4. Storage

### 4.1 Exact fields

`public.integration_credentials`:

| Column | Type | Notes |
|---|---|---|
| `id` | `bigint generated always as identity primary key` | |
| `integration_id` | `bigint not null references public.task_source_integrations (id)` | Owner |
| `selector` | `text not null unique check (selector ~ '^[0-9abcdefghjkmnpqrstvwxyz]{16}$')` | Public handle |
| `secret_hash` | `text not null check (secret_hash ~ '^[0-9a-f]{64}$')` | SHA-256 hex, lowercase |
| `label` | `text not null check (length(trim(label)) between 1 and 100)` | Operator-facing, e.g. `n8n production` |
| `created_by_user_id` | `bigint not null references public.users (id)` | |
| `created_at` | `timestamptz not null default now()` | |
| `last_used_at` | `timestamptz` | Throttled write (§5.3); the evidence that makes rotation safe |
| `expires_at` | `timestamptz` | Optional; null means no expiry |
| `revoked_at` | `timestamptz` | |
| `revoked_by_user_id` | `bigint references public.users (id)` | |
| `revoked_reason` | `text check (revoked_reason in ('ROTATED','COMPROMISED','DECOMMISSIONED','INTEGRATION_DISABLED'))` | |
| `rotation_of_credential_id` | `bigint references public.integration_credentials (id)` | Rotation lineage |
| `updated_at` | `timestamptz not null default now()` | Existing `set_governance_updated_at` trigger |

Check constraint: `(revoked_at is null and revoked_by_user_id is null and revoked_reason is null)
or (revoked_at is not null and revoked_by_user_id is not null and revoked_reason is not null)` —
matching the shape already used by `integration_capabilities`.

**The raw secret appears in exactly one place for its entire lifetime**: the HTTP response (or CLI
stdout) that created it. It is never written to the database, never logged, never returned again.

### 4.2 Hashing algorithm and why it is the right one

`sha256(secret_utf8)` → 64 lowercase hex characters.

- **Unsalted, deliberately.** A salt defeats precomputation across many low-entropy secrets.
  There is no precomputation advantage against a 256-bit uniform random value — no dictionary, no
  rainbow table, and no cross-credential reuse to exploit. A salt here would add a column and a
  round trip in exchange for nothing.
- **Deterministic, deliberately.** A password hash is non-deterministic by design, which is
  precisely why password hashes cannot be looked up. That property is a cost, not a benefit, and
  the selector already gives us the lookup we need. Determinism additionally lets the comparison
  happen inside the RPC in a single round trip.
- **No pepper.** A pepper protects a stolen *database* whose secrets are guessable. These are not.
  It would add a key-management problem (where does the pepper live, how is it rotated) to solve a
  problem 256 bits of entropy has already solved.

### 4.3 Why raw secrets cannot be recovered

The database holds only `sha256(secret)`. Recovering the secret means inverting SHA-256 on a
uniformly random 256-bit preimage — no dictionary, no structure, no shortcut. An attacker with a
full database dump learns which credentials exist and when they were used, and cannot authenticate
as any of them. Because the table is RPC-only (§8.2), even the application's own `service_role`
cannot `SELECT secret_hash`.

## 5. Request authentication lifecycle

### 5.1 The path of one request

```
POST /api/internal/tasks
  1  onRequest      P1-03 "internal" policy, IP-keyed.  Also inspects the per-IP
                    auth-failure bucket, so a source that has been failing is
                    rejected here — before any parsing or database work.
  2  preHandler     Read X-Integration-Key. Shape-check prefix, lengths, charset.
                    Malformed -> uniform 401 (no database call at all).
  3  preHandler     Split selector | secret.  hash = sha256(secret) in Node.
  4  preHandler     ONE rpc: authenticate_integration_credential(
                        p_selector, p_secret_hash, p_required_capability)
  5  preHandler     status !== 'OK'  ->  uniform 401 INTEGRATION_UNAUTHORIZED
  6  preHandler     request.integrationPrincipal = { integrationId, credentialId,
                                                     code, source, requestingDivisionId }
  7  preHandler     app.rateLimitIntegrationIdentity(request, integrationId)   [P1-03, unchanged]
  8  preHandler     If X-Integration-Code present and !== principal.code -> 401
  9  handler        Business logic, using the principal — never the header.
 10  onResponse     If 401, P1-03 charges the per-IP auth-failure bucket.  [unchanged]
```

Steps 1, 7 and 10 are **existing P1-03 machinery used as-is**. `rateLimitIntegrationIdentity` is
already keyed by integration id and already declared in the plugin; P1-04 changes no limiter code.

### 5.2 The RPC does the whole check

`authenticate_integration_credential` performs, in one round trip:

1. Indexed lookup on `selector`.
2. Compare `secret_hash`.
3. Check `revoked_at is null`, `expires_at is null or expires_at > now()`.
4. Join `task_source_integrations` and check `active`.
5. If `p_required_capability` is non-null, check `integration_capabilities` for an active grant.
6. Throttled `last_used_at` touch.
7. Return the integration row plus a status enum.

This **replaces** `findActiveByCode` and folds in `hasActiveCapability`, so `/api/internal/tasks`
goes from two database round trips to one. P1-04 makes the authenticated path cheaper than the
unauthenticated one it replaces.

**Hash comparison happens in SQL, and that is safe here.** Postgres `=` on text is not
constant-time, but the compared values are *digests of the attacker's own guess* versus a *digest
of a 256-bit random secret*. A perfect byte-level timing oracle would leak leading bytes of
`sha256(secret)`, which is not invertible and confers no advantage. The property that makes this
sound is comparing hashes rather than raw secrets — the same reason P1-01 can compare session
token hashes.

**Uniform work on miss.** When the selector does not resolve, the function still compares against
a fixed dummy digest before returning, so an unknown selector and a wrong secret take
indistinguishable time. This mirrors P1-01's `DUMMY_PASSWORD_HASH`.

### 5.3 `last_used_at` throttling

Written only when the stored value is null or older than 60 seconds — the same throttle P1-01 uses
for session `last_seen_at`, and for the same reason: an unthrottled touch turns every read into a
write and every authenticated request into row contention.

Consequence for operators: `last_used_at` may lag by up to a minute. Rotation guidance (§6) must
say "wait at least a minute before revoking", because this field is the evidence the new
credential is live.

### 5.4 Failure behaviour

| Condition | Status | HTTP |
|---|---|---|
| Header absent or malformed | — | `401 INTEGRATION_UNAUTHORIZED` |
| Selector unknown | `UNKNOWN` | `401 INTEGRATION_UNAUTHORIZED` |
| Secret mismatch | `BAD_SECRET` | `401 INTEGRATION_UNAUTHORIZED` |
| `revoked_at` set | `REVOKED` | `401 INTEGRATION_UNAUTHORIZED` |
| `expires_at` passed | `EXPIRED` | `401 INTEGRATION_UNAUTHORIZED` |
| Integration `active = false` | `INTEGRATION_INACTIVE` | `401 INTEGRATION_UNAUTHORIZED` |
| Capability not granted | `CAPABILITY_MISSING` | `403 INTEGRATION_CAPABILITY_REQUIRED` |
| Code header disagrees | — | `401 INTEGRATION_UNAUTHORIZED` |

Every authentication failure returns the **same** status, the same code, and the same constant
message. The distinct status enum exists for server-side logging only. A client can never learn
whether a selector exists, whether a credential was revoked, or whether an integration was
disabled. Capability failure is the one deliberate exception: it is a *post-authentication*
authorization outcome, the caller is already proven, and `403` is the honest answer — it is also
the behaviour that exists today.

**No caching.** The RPC runs on every request. Revocation therefore takes effect on the next
request, with no TTL and no invalidation protocol. This is the same trade P1-01 made for sessions
and the reason revocation can be trusted.

## 6. Rotation and revocation lifecycle

### 6.1 Overlap, not cutover

The supported rotation is **overlapping**, because an immediate cutover cannot be made safe: there
is no instant at which the operator can atomically swap the secret inside n8n and inside Sotoayam,
so a cutover always has a window in which the automation is broken.

```
1. CREATE     POST .../credentials            -> raw secret returned ONCE.  Now 2 active.
2. DEPLOY     Operator updates n8n / the ERP adapter to the new value.
3. VERIFY     GET .../credentials  ->  new credential shows a non-null last_used_at.
              (Wait >60s; §5.3.)   This step is what makes rotation safe rather than hopeful.
4. RETIRE     POST .../credentials/<old>/revoke    (optionally with grace_seconds)
                                                -> back to 1 active.
```

### 6.2 Maximum two active credentials per integration

Two is the smallest number that permits overlap, and the largest number that keeps the active set
comprehensible. Three or more means the operator has lost track of which secret is deployed where
— the precise failure mode credentials are meant to eliminate. Creation past the limit returns
`409 INTEGRATION_CREDENTIAL_LIMIT` naming the credentials that must be retired first.

The limit is enforced **inside** `pg_advisory_xact_lock(hashtextextended('sotoayam_integration_credential:'
|| p_integration_id, 0))`, reusing the advisory-lock idiom already present in
`grant_integration_capability`, so two concurrent creations cannot produce three active rows.

### 6.3 Grace period versus immediate revocation

Both exist, on separate columns, for separate purposes:

- `expires_at` — planned retirement. `revoke` with `grace_seconds` (1 s … 7 days) leaves
  `revoked_at` null and applies a monotonic deadline: a null expiry becomes `now() + grace`, an
  existing future expiry may only be shortened, and an already-expired credential is rejected
  deterministically rather than reactivated.
- `revoked_at` — immediate kill, for a leak or a decommission. Effective on the next request.

Revocation may always be applied to a credential that already has a grace deadline, and takes
precedence. Authentication treats either condition as failure.

### 6.4 Rollback and recovery

- If the new credential misbehaves in the field, the old one is **still active** — that is the
  entire point of overlap. Rollback is "keep using the old value", requiring no server action.
- Once revoked, a credential is gone. **Revocation is monotonic; there is no un-revoke.** Recovery
  is always "create a new credential", never "restore an old one". The same invariant P1-01
  applies to sessions, for the same reason: an un-revoke turns an audited kill switch into a
  reversible suggestion.
- If every credential for an integration is lost, the operator creates a new one through the admin
  API or the CLI (§9). No path recovers a raw secret, by construction.
- If an *integration* is compromised rather than a credential,
  `revoke_integration_credentials_for_integration` kills all of its credentials in one statement,
  and `setActive(false)` independently disables it even if a credential were missed.

### 6.5 Audit requirements

Lifecycle events append to the existing `audit_logs` with `actor_type = 'USER'` and
`object_type = 'INTEGRATION_CREDENTIAL'`:

| Action | When |
|---|---|
| `INTEGRATION_CREDENTIAL_CREATED` | Creation, `after_state` carries `rotation_of_credential_id` when rotating |
| `INTEGRATION_CREDENTIAL_REVOKED` | Immediate revocation, with reason |
| `INTEGRATION_CREDENTIAL_GRACE_SET` | Grace deadline applied |
| `INTEGRATION_CREDENTIALS_PURGED` | Bulk revocation for a compromised integration |

Audit rows carry the **selector**, integration id, label and reason. They never carry the secret or
its digest. Because all four are `USER`-actor events, the historical
`actor_type in ('USER','SYSTEM')` check constraint needs no change.

**Per-request usage is not audited.** One audit row per API call would make the busiest table in
the product attacker-writable and would bury the lifecycle events that matter. `last_used_at` plus
the existing `task_import_batches.integration_id` provenance already answer "who did this".

**Failed attempts are not persisted either** — no `admin_login_attempts` analogue. That table
exists to power a durable per-account cooldown for guessable human passwords. A 256-bit secret
needs no cooldown (§7 T-2), and a durable failure log written by unauthenticated callers is an
unbounded growth vector.

## 7. Threat and abuse cases

| ID | Threat | Control |
|---|---|---|
| T-1 | **Credential enumeration** — probing for valid selectors | 80-bit random selectors; identical 401 code/message for every failure mode; uniform work on miss via dummy-digest comparison; P1-03 per-IP auth-failure bucket gates repeated attempts before parsing |
| T-2 | **Brute force** of the secret | 256 bits. At 10⁹ guesses/second an attacker needs ~10⁵⁸ years. P1-03 bounds request volume. **No per-credential lockout, deliberately** — a lockout on a machine credential is a remote off-switch for a customer's production automation, triggerable by any stranger. This is the deliberate asymmetry with P1-01, where lockout protects a guessable human password |
| T-3 | **Leaked secret** (committed, logged, pasted) | Greppable `soto_ik_` prefix; `check:secrets` pattern; the credential is never logged or echoed after creation; `Cache-Control: no-store` on the two responses that carry it; immediate revoke; `last_used_at` shows whether it was used after the leak; per-integration blast radius instead of total compromise |
| T-4 | **Replay** of a captured request | Bearer credentials over TLS. Idempotent intake `(source, external_event_id)` already collapses replayed notification events. **We do not add request signing or nonces in v1** — accepted residual risk: HMAC signing would require every integration author to implement canonicalisation correctly, and a wrong implementation is worse than TLS. Revisit if a customer terminates TLS at an untrusted hop |
| T-5 | **Timing leak** | Hash-versus-hash comparison leaks only digest prefixes, which are not invertible (§5.2); uniform work on selector miss |
| T-6 | **Duplicate credentials** | `unique (selector)`. Deliberately **no** unique index on `secret_hash`: a uniqueness violation on insert would confirm a digest already exists, and collision is impossible at 256 bits anyway |
| T-7 | **Compromised integration** | `revoke_integration_credentials_for_integration` in one statement; `setActive(false)` fails authentication even with a valid credential, since the RPC re-checks `active` per request; capabilities revocable independently |
| T-8 | **Rotation race** | `pg_advisory_xact_lock` per integration; the ≤2 rule evaluated inside the lock |
| T-9 | **Revoked credential reuse** | Checked in the same RPC on every request; no caching, so revocation is effective on the next call; revocation monotonic |
| T-10 | **Identity spoofing via `X-Integration-Code`** — today's actual hole | The code stops being an identity source. Identity is derived from the credential; a present code header must agree or the request is refused |
| T-11 | **Privilege crossing** — an integration credential used against an admin route | Integration authentication is registered only on internal scopes. `resolveAdminPrincipal` is untouched and never consults `X-Integration-Key`; an admin route sees only a missing admin credential and returns 401 (test P4-21) |
| T-12 | **Secret exposed in transport metadata** | Header-only; no query-parameter form; proxies log URLs, not headers |
| T-13 | **Database dump** | Only digests at rest; the table is RPC-only, unreadable even by `service_role` |

## 8. Database changes

One additive migration, `202609110001_create_integration_credentials.sql`, bringing the repository
total to **17**. All 16 historical migrations remain byte-identical.

### 8.1 Objects created

1. `public.integration_credentials` (§4.1).
2. Indexes:
   - `unique (selector)` — the authentication lookup, and the only index on the hot path.
   - `integration_credentials_active_idx on (integration_id) where revoked_at is null` — powers
     listing and the ≤2 enforcement.
3. `set_integration_credentials_updated_at` trigger reusing the existing
   `public.set_governance_updated_at()`.
4. `alter table public.notification_events add column integration_id bigint references
   public.task_source_integrations (id);` — nullable, additive, attribution only (§8.3).

### 8.2 Security model

`integration_credentials` follows the P1-01 `admin_sessions` posture exactly:

```sql
alter table public.integration_credentials enable row level security;
revoke all on table public.integration_credentials from public, anon, authenticated, service_role;
```

The application's `service_role` **cannot read `secret_hash` directly**. All access is through
SECURITY DEFINER functions, each with `set search_path = ''`, each revoked from
`public, anon, authenticated` and granted only to `service_role`:

| Function | Purpose |
|---|---|
| `authenticate_integration_credential(p_selector text, p_secret_hash text, p_required_capability text)` | The whole authentication check (§5.2). Returns status + integration row + credential id. Never returns `secret_hash` |
| `create_integration_credential(p_integration_id, p_selector, p_secret_hash, p_label, p_expires_at, p_rotation_of_credential_id, p_actor_user_id)` | Authority check, advisory lock, ≤2 enforcement, audit |
| `revoke_integration_credential(p_credential_id, p_reason, p_grace_seconds, p_actor_user_id)` | Immediate revoke or grace deadline |
| `revoke_integration_credentials_for_integration(p_integration_id, p_reason, p_actor_user_id)` | Compromise response |
| `list_integration_credentials(p_integration_id, p_actor_user_id)` | Metadata only; `secret_hash` is not in the return type |

The four mutating functions reuse the existing SYSTEM_ADMIN authority guard already enforced by
`create_task_source_integration`, so database-level authority is identical to the surrounding
integration-administration surface.

There is **no janitor and no pruning path**. Expiry is evaluated live against `expires_at`;
credentials are never deleted, because the row is the audit trail. (P1-01's `create_admin_session`
contains an UPDATE immediately followed by a DELETE with the same predicate — dead work. This
design does not repeat it.)

### 8.3 Notification attribution, and what is deliberately *not* changed

`POST /api/notifications/send` currently authenticates with `INTERNAL_API_KEY` and has no
integration identity at all; `notification_events.source` defaults to `'INTERNAL_API'`.

It is tempting to set `source` to the authenticated integration code. **Do not.**
`(source, external_event_id)` is the authoritative idempotency key. Changing `source` at the moment
a caller migrates would move that caller into a fresh namespace, so an `event_id` already consumed
under `'INTERNAL_API'` would be accepted again — a **duplicate broadcast** during exactly the
window operators are least able to notice. Instead:

- `source` semantics are byte-identical to today.
- The authenticated integration is recorded in the new nullable
  `notification_events.integration_id` column.
- A new, distinctly named `intake_attributed_notification_event(...)` takes the extra parameter.
  The historical `intake_notification_event` is **not** replaced and **not** overloaded — an
  overload of the same name would create the PostgREST resolution ambiguity flagged during P0-13
  and avoided there by naming `provision_first_installation` distinctly.

Narrowing the idempotency namespace per integration may well be right, but it is a deliberate
data-semantics decision belonging to P2-08 ("require external reference where automation
idempotency depends on it"), not a side effect of an authentication change.

## 9. API and admin surfaces

Three routes added to the **existing** `integrationAdministrationRoutes` group, so they inherit
`defineAdminRoutes` — the fail-closed admin scope, the session-first principal, CSRF on mutations,
the P1-03 `admin-write` policy stamped by the group's `onRoute` hook, and the security manifest.
No new admin route group is created, and no route file implements its own credential check.

| Method | Path | Authority | Returns |
|---|---|---|---|
| `GET` | `/api/admin/integrations/:id/credentials` | Session + active SYSTEM_ADMIN | Metadata list: id, selector, label, created_at, created_by, last_used_at, expires_at, revoked_at, revoked_reason, derived `status`. **Never** the secret or its digest |
| `POST` | `/api/admin/integrations/:id/credentials` | Session + active SYSTEM_ADMIN | `201`. `{ id, selector, credential, expires_at }` — **the only response in the product that contains a raw credential**, returned exactly once |
| `POST` | `/api/admin/integrations/:id/credentials/:credentialId/revoke` | Session + active SYSTEM_ADMIN | `200` with updated metadata. Body optionally `{ reason, grace_seconds }` |

All three require an authenticated administrator **session** with active SYSTEM_ADMIN authority —
the boundary D-007 already establishes for this group, re-checked per request by
`resolveAdminActor`. Authority is additionally enforced inside the SECURITY DEFINER functions, so
the guarantee does not depend on the route layer alone.

The creation response sets `Cache-Control: no-store` and is excluded from any body logging. Codex
must confirm the pino configuration does not serialize response bodies before shipping.

**CLI:** `npm run integration:credential -- --code <CODE> --label "<label>" --email <admin-email>`, compiled to
`dist/src/cli/integration-credential.js`, mirroring `admin:reset-password`. It exists because the
first credential must be creatable before the admin UI does (P3-02 lists integrations but does not
yet manage credentials), and because a locked-out operator needs a server-side path. It prints the
credential once to stdout and writes it nowhere. The email selects an active SYSTEM_ADMIN actor
explicitly; the CLI never chooses one arbitrarily when multiple administrators exist.

## 10. ADMIN_API_KEY and INTERNAL_API_KEY transition

Two shared secrets, one mechanism, symmetric staging. Both keep an env-gated fallback whose use is
audited once per process, so the decision to disable is driven by evidence rather than optimism.

### 10.1 INTERNAL_API_KEY

**I-Stage A — P1-04 ships.** `X-Integration-Key` is tried first. If absent, `X-Internal-Api-Key` is
accepted exactly as today, gated by a new `INTERNAL_API_KEY_FALLBACK_ENABLED` (default `true`).
Fallback use is logged and audited once per process as `INTERNAL_API_KEY_FALLBACK_USED`, reusing
the `observeApiKeyFallback` pattern. **Existing installations upgrade with zero downtime and no
configuration change.** When the legacy key authenticates `/api/internal/tasks`, the legacy
`X-Integration-Code` path stays in force for that request only — otherwise the upgrade would break
the caller it is meant to protect.

**I-Stage B.** Default flips to `false`. The gate is mechanically checkable: every active
integration has at least one credential whose `last_used_at` is non-null, and no
`INTERNAL_API_KEY_FALLBACK_USED` audit row exists since the upgrade. `npm run check:integration-credentials`
reports exactly this and must print a clear verdict before an operator flips it.

**I-Stage C.** The fallback branch, `INTERNAL_API_KEY`, and the caller-supplied-code identity path
are deleted. `X-Integration-Code` becomes ignored rather than merely non-authoritative.

### 10.2 ADMIN_API_KEY

Current behaviour (P1-01 Stage A): required at startup with a 32-character minimum, accepted on
all 12 admin groups after the session attempt fails, disable-able via
`ADMIN_API_KEY_FALLBACK_ENABLED=false`, unused by the browser, audited once per process.

**P1-04 executes Stage B.** Specifically:

- `ADMIN_API_KEY_FALLBACK_ENABLED` default flips **`true` → `false`**.
- `ADMIN_API_KEY` becomes optional at startup, still validated at ≥32 characters when present, and
  still required when the fallback is explicitly enabled.
- Enabling the fallback logs a deprecation warning at every startup.

This is where P1-04 earns its place in the removal path: it removes the last *legitimate* reason a
machine would hold a shared admin secret. Any automation that needs to reach Sotoayam now has its
own credential on its own surface, so a deployment still needing `ADMIN_API_KEY` is one with a
human process to fix, not a missing capability.

**The explicit migration path** — flipping a default does change behaviour for an install whose
operator scripts still send the key, so it does not ship bare:

1. `npm run check:admin-key-usage` queries `audit_logs` for `ADMIN_API_KEY_FALLBACK_USED` since a
   given date and prints `SAFE TO DISABLE` or the dates it was used.
2. The upgrade notes state the flip, the one-line opt-back-in
   (`ADMIN_API_KEY_FALLBACK_ENABLED=true`), and that opting in is temporary.
3. The startup deprecation warning makes a still-enabled fallback visible in the logs every day.

**Stage C — deletion — is explicitly *not* in P1-04.** Preconditions: two consecutive releases
shipped with the default off; no supported installation reporting an opt-in; P3-01 login UI
shipped. Only then are the fallback branch, the `shared-api-key` variant of `AdminPrincipal`, the
singleton actor branch, and the configuration entry deleted. Scheduling deletion behind observed
evidence is the point; a deletion date chosen in advance would be a guess.

## 11. Testing and acceptance criteria

`tests/security/integration-credentials.test.ts`

- **P4-01** A valid `X-Integration-Key` authenticates and resolves the owning integration.
- **P4-02** Absent, malformed, wrong-prefix, wrong-length and wrong-charset headers all return
  `401 INTEGRATION_UNAUTHORIZED`, and no database call is made for shape failures.
- **P4-03** A valid selector with a wrong secret returns 401.
- **P4-04** Unknown selector, wrong secret, revoked, expired and inactive-integration produce a
  **byte-identical** response body and status — the enumeration-oracle test.
- **P4-05** A credential for integration A cannot act as integration B; the resolved
  `requesting_division_id` is A's.
- **P4-06** `X-Integration-Code` disagreeing with the credential is refused; agreeing is accepted;
  absent is accepted. **The code alone never authenticates** (D-009's acceptance test).
- **P4-07** Capability failure returns `403 INTEGRATION_CAPABILITY_REQUIRED`, distinct from 401.
- **P4-21** An integration credential presented to an admin route does not authenticate; the admin
  boundary is unchanged (P1-01 preservation).

`tests/security/integration-credentials-database.test.ts` (opt-in disposable PostgreSQL, matching
the existing `SOTOAYAM_TEST_POSTGRES_ADMIN_URL` harness)

- **P4-08 Hash at rest.** After creating a credential, no row in any table contains the raw secret;
  `secret_hash` equals `sha256(secret)` and the raw value appears nowhere in the database.
- **P4-09** `integration_credentials` is unreadable by `service_role` directly; only the RPCs
  return data, and none returns `secret_hash`.
- **P4-10 Per-integration isolation.** Revoking A's credential leaves B's working.
- **P4-11 Rotation overlap.** With two active credentials both authenticate; after revoking the
  first, only the second does.
- **P4-12** Creating a third active credential fails with `409`, and the limit holds under
  concurrent creation (advisory lock).
- **P4-13 Revocation immediacy.** A revoked credential fails on the very next request, with no
  restart and no cache flush.
- **P4-14** Grace period: a credential with `expires_at` in the future authenticates; past, it does
  not. Revocation overrides an existing grace deadline.
- **P4-15** `last_used_at` is set on first use and throttled to at most one write per 60 s.
- **P4-16** `setActive(false)` on the integration fails authentication even with a valid
  credential; `revoke_integration_credentials_for_integration` kills every credential at once.
- **P4-17** Every lifecycle audit row exists with `actor_type = 'USER'` and contains the selector
  but neither the secret nor the digest.
- **P4-18 Unknown-selector timing.** Unknown-selector and bad-secret paths perform the same work
  (asserted structurally — the dummy comparison executes — not by wall-clock measurement).

`tests/security/integration-credential-routes.test.ts`

- **P4-19** All three admin routes require a session with active SYSTEM_ADMIN authority; the group
  remains in the security manifest and is CSRF-protected on mutations.
- **P4-20** The raw credential is returned **only** by create, exactly once; a subsequent `GET`
  never contains it; the create response sets `Cache-Control: no-store`.
- **P4-22 P1-03 identity.** Two credentials of one integration share one rate-limit budget (keyed
  by integration id, so rotation neither resets nor doubles it); two different integrations have
  independent budgets; repeated 401s charge the per-IP auth-failure bucket.
- **P4-23** No plaintext credential reaches the logs: with a capturing logger, no emitted line
  contains the raw secret or the `soto_ik_` prefix, for success or failure.

`tests/security/internal-key-transition.test.ts`

- **P4-24** With `INTERNAL_API_KEY_FALLBACK_ENABLED=true`, the legacy key plus
  `X-Integration-Code` still works — the zero-downtime upgrade guarantee.
- **P4-25** With it `false`, the legacy key is refused and only credentials work.
- **P4-26** Legacy fallback use is audited once per process, not per request.
- **P4-27** `ADMIN_API_KEY_FALLBACK_ENABLED` now defaults to `false`; setting it `true` restores
  Stage A behaviour across all 12 groups and logs a deprecation warning.
- **P4-28** `ADMIN_API_KEY` absent at startup is accepted; present-but-short is still rejected;
  absent **and** fallback explicitly enabled is rejected at startup.

`tests/migration/` and `tests/commercial/`

- **P4-29 Migration integrity.** 17 migrations; all 16 historical hashes unchanged; the new
  migration applies cleanly to a fresh database and is additive only.
- **P4-30** `scripts/check-secrets.ts` detects a `soto_ik_` value, proving the leaked-credential
  scanner works.
- **P4-31** `notification_events.source` semantics are unchanged for both authentication paths;
  `integration_id` is populated only on the credential path.

### Acceptance criteria

1. Exactly one new migration; no historical migration modified; `audit_logs` constraint unchanged.
2. No new production dependency; no Redis; no cache layer.
3. `resolveAdminPrincipal`, session handling, CSRF and cookie behaviour byte-unchanged (P1-01).
4. No outbound HTTP change (P1-02).
5. No change to `src/http/rate-limit*.ts`; P1-04 consumes the existing
   `rateLimitIntegrationIdentity` decoration (P1-03).
6. Every existing test passes; existing internal-API callers work with no configuration change.
7. Typecheck, build, contract tests, governance checks and secret scan pass.
8. `.env.example`, `README.md` and `docs/deployment/clean-install.md` document the new variables,
   the credential format, and the rotation procedure.

## 12. Cross-section consistency check

Checked pairwise across §3–§11.

| # | Checked | Result |
|---|---|---|
| 1 | ≤2 active credentials vs. rotation overlap | Consistent — 2 is the minimum overlap needs |
| 2 | ≤2 active vs. "revoke one without affecting others" | Consistent — revocation is per-credential row |
| 3 | `expires_at` grace vs. immediate `revoked_at` | Consistent — separate columns; revoke overrides grace; auth treats either as failure (§6.3 states the precedence explicitly) |
| 4 | Rate-limit identity keyed by integration vs. per-credential lifecycle | Consistent and intentional — rotation must not reset or double the budget (P4-22) |
| 5 | Uniform 401 vs. "define behaviour for revoked/expired" | Consistent — distinguished in the server-side status enum and logs, never in the response |
| 6 | No lockout (§7 T-2) vs. P1-01's lockout for humans | Consistent, and the asymmetry is deliberate and justified: entropy differs by orders of magnitude, and machine lockout is a remote off-switch |
| 7 | Credential auth on internal routes vs. P1-01 admin boundary | Consistent — separate principals, separate scopes, `resolveAdminPrincipal` untouched (P4-21) |
| 8 | Attribution vs. `(source, external_event_id)` idempotency | **Initially conflicting; resolved** by not changing `source` and adding a separate `integration_id` column. Had `source` been switched at migration time, an already-consumed `event_id` would have been re-accepted under the new namespace and rebroadcast |
| 9 | New RPC vs. historical `intake_notification_event` | Consistent — distinctly named function, no overload, no PostgREST ambiguity |
| 10 | Extra RPC per request vs. P1-03 cost goals | Consistent — the RPC *replaces* `findActiveByCode` and absorbs `hasActiveCapability`, so `/api/internal/tasks` drops from two round trips to one |
| 11 | P1-03 trusted-IP exemption vs. credential auth | Consistent — the exemption skips rate limiting only; authentication is independent and still enforced |
| 12 | SQL `=` hash comparison vs. the timing requirement | Consistent — digests, not secrets, are compared; a leaked digest prefix is not invertible (§5.2) |
| 13 | `last_used_at` 60 s throttle vs. rotation verification | Consistent with a documented consequence: operators must wait >60 s before revoking. Recorded in §5.3 and §6.1 |
| 14 | "Never delete credentials" vs. table growth | Consistent — bounded by ≤2 active plus revoked history, a handful of rows per integration per year |
| 15 | Expiry handling vs. the P1-01 dead-code lesson | Consistent — expiry is evaluated live; no janitor, no UPDATE-then-DELETE pair |
| 16 | Stage B default flip vs. "do not break existing installations" | Consistent **only because** the opt-in flag, the usage checker and the upgrade note exist (§10.2). Without those three it would be a breaking change |

**One implementation constraint, not a design conflict, that Codex must honour.**
`tests/commercial/origin-state-cleanup.test.ts` asserts both that `README.md` contains
`/ADMIN_API_KEY[^\n]*minimal 32 karakter/` **and** that it does *not* contain
`/ADMIN_API_KEY[^\n]*opsional/i`. Stage B makes `ADMIN_API_KEY` optional, so the obvious README
edit would fail a P0-15 commercial guard. The README must therefore express optionality without
the word `opsional` on that line while keeping the `minimal 32 karakter` phrase — for example
"`ADMIN_API_KEY` hanya diperlukan bila fallback kompatibilitas diaktifkan, dan minimal 32
karakter." That satisfies both assertions. Flagged here so it is a deliberate wording choice
rather than a surprise test failure.

**Unresolved design conflicts: none.**

## 13. Verdict

**GO.**

Every required outcome is met: each integration holds its own credential; the integration code is
demoted from identity to optional assertion; only a SHA-256 digest is stored; the selector makes
lookup practical without plaintext; revocation is per-credential and immediate; rotation has a
verified overlap path with defined rollback; P1-01, P1-02 and P1-03 boundaries are untouched (P1-03
is consumed, not modified); the ADMIN_API_KEY removal path is staged with an evidence gate and an
explicit opt-in for existing installs; one additive migration; no Redis; no multi-tenancy; and the
authenticated hot path is cheaper than the unauthenticated one it replaces.
