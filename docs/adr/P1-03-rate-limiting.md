# P1-03 — Application-Level Rate Limiting

Status: Proposed (design only; no implementation)
Owner: Claude Code architecture -> Codex implementation
Depends on: P1-01 (`docs/adr/P1-01-admin-identity-sessions.md`), P1-02 outbound HTTP client
Applies to: D-002 (one instance per customer), D-003 (one Fastify process), D-004 (no Redis), D-015 (cheap infrastructure)

## 1. Problem

Sotoayam currently has no request-volume control of any kind. Every protected surface is
credential-checked but unbounded:

- `POST /api/admin/auth/login` performs a scrypt verification (N=32768, r=8 — roughly 32 MB and
  50–100 ms per attempt) on **every** request, including requests with an unknown email, because
  P1-01 deliberately verifies a dummy hash to equalize timing. Node runs scrypt on the libuv
  threadpool (4 threads by default) with an unbounded queue. A few dozen concurrent login POSTs
  therefore consume ~32 MB each in flight and queue unboundedly. On the 1–2 GB VPS this product
  targets, this is a memory-exhaustion and latency-collapse vector, not merely a CPU cost.
- The P1-01 login gate is evaluated *inside* the handler, after two database round trips. A
  throttled attacker still pays the application two RPCs per attempt.
- The Stage A `ADMIN_API_KEY` fallback is reachable on all 12 admin route groups with **no**
  attempt limiting at all. `evaluate_admin_login_gate` covers passwords only.
- `POST /api/admin/auth/password` compares `current_password` with scrypt and is **not** covered
  by the login gate, so a stolen session (or XSS) can brute-force the current password freely.
- `INTERNAL_API_KEY` on `/api/notifications/send` and `/api/internal/*` has no attempt limiting.
- Every authenticated admin request costs one `validate_admin_session` RPC, so unauthenticated
  floods translate directly into database load.

P1-03 adds a transport-level volume boundary in front of all of this.

## 2. Decision summary

D-P1-03-A. Rate limiting is implemented **in-process, in memory**, with no Redis, no new
database table, and no migration.

D-P1-03-B. The algorithm is a **token bucket** per key: capacity equals the configured
per-minute limit, refilled continuously at limit/60 tokens per second.

D-P1-03-C. Policy is attached to routes **structurally**, via an `onRoute` stamp inside
`defineAdminRoutes` and explicit `config.rateLimit` on the few special routes — never by matching
URL strings at request time.

D-P1-03-D. The limiter is an **availability** control, not an authorization control. It fails
**open** on any internal error. Authentication remains independently fail-closed.

D-P1-03-E. Rate limit state is **deliberately volatile**. The durable, restart-surviving
guarantee for credential guessing stays where P1-01 already put it: `admin_login_attempts`.

## 3. Why no Redis, and no database

D-004 forbids Redis without evidence that Postgres is insufficient. Here even Postgres is
unnecessary:

- One instance per customer (D-002), one Fastify process (D-003). There is exactly one counter
  holder, so a shared store buys **nothing** — no coordination problem exists.
- A database-backed counter would add one write per request to the hot path, which is the
  opposite of what a DoS control should do: it would convert a flood of cheap rejections into a
  flood of database writes, amplifying the attack it is meant to stop.
- Redis would add a second daemon, its own memory footprint, its own failure mode and its own
  recurring cost to a deployment whose entire premise (D-015) is a cheap single VPS.

Cost of the choice: counters reset on restart (§9), and horizontal scaling would need revisiting.
Neither is in v1.x scope.

## 4. Why not `@fastify/rate-limit`

`@fastify/rate-limit` is a reasonable, maintained option and remains an acceptable fallback if
implementation reveals unforeseen complexity. It is not the recommendation because the
configuration Sotoayam needs is nearly all custom anyway — a two-stage key (IP before routing
cost, principal after `resolveAdminPrincipal`), an error envelope that must match `AppError`, a
401-penalty bucket driven from `onResponse`, an explicit fail-open contract, and a bounded key
map with a documented eviction policy. Wiring those into the plugin is comparable in volume to
the ~150 lines of dependency-free code proposed here, while adding a production dependency to a
security product that already implements its own constant-time comparison and session layer.

## 5. Architecture

### 5.1 Modules

```
src/http/rate-limit.ts          TokenBucketLimiter: pure, no I/O, no Fastify types
src/http/rate-limit-policy.ts   Named policies + config -> policy resolution
src/http/rate-limit-plugin.ts   Fastify wiring: onRequest, onResponse, onClose
```

`src/auth/admin-authorization.ts` gains exactly one addition: an `onRoute` stamp and an
identity-keyed consume immediately after `resolveAdminPrincipal`. Nothing about principal
resolution, CSRF, or the scope contract changes.

### 5.2 TokenBucketLimiter

```
consume(key: string, policy: Policy, cost = 1): { allowed: boolean; retryAfterSeconds: number }
```

State is `Map<string, { tokens: number; updatedAt: number }>`. On each call the bucket is
refilled by `elapsed * policy.perMinute / 60`, clamped to capacity. When `tokens < cost` the call
is refused and `retryAfterSeconds = max(1, ceil((cost - tokens) / refillRate))`.

Memory is bounded by `RATE_LIMIT_MAX_KEYS`. On insert past the cap the limiter first sweeps
entries that have refilled to capacity (they carry no information), then, if still over cap,
evicts the least-recently-updated entries. A single `setInterval` sweep every 60 s, created with
`.unref()`, keeps idle memory flat; it is cleared from a Fastify `onClose` hook so the test suite
can build and dispose many apps without leaking timers.

### 5.3 Request pipeline

| Stage | Hook | Key | Purpose |
|---|---|---|---|
| 1 | `onRequest` (global) | client IP (or keyless global bucket) | Reject before body parsing, before routing cost, before any database call |
| 2 | `preHandler` inside `defineAdminRoutes`, after `resolveAdminPrincipal` | `session:<adminUserId>` or `apikey` | Per-identity fairness; one admin cannot starve another |
| 3 | `onResponse` (global) | client IP | On `statusCode === 401`, consume from the per-IP auth-failure bucket |

Stage 3 is what protects the `ADMIN_API_KEY` fallback and the internal API keys, without editing
a single route file: any credential rejection anywhere in the app feeds one shared per-IP penalty
bucket. Because it runs on the response, it costs nothing on the success path.

Stage 1 runs before P1-01's `evaluate_admin_login_gate`, which is the point: a throttled source
never reaches scrypt or the database.

### 5.4 Policy attachment (fail-closed classification)

Policies are named, not inferred from URLs:

- `defineAdminRoutes` registers an `onRoute` hook in its encapsulated scope that sets
  `routeOptions.config.rateLimit ??= isReadMethod(method) ? "admin-read" : "admin-write"`.
  Every present and future admin group therefore inherits a policy automatically, matching the
  existing "new admin groups must use `defineAdminRoutes`" contract.
- The handful of special routes declare their policy explicitly at registration:
  `{ config: { rateLimit: "login" } }` and so on.
- Routes with no policy fall to `default` (IP-keyed, moderate). A manifest test (§15, RL-11)
  enumerates the registered route table and asserts every route resolves to an *intended* policy,
  so a new sensitive route cannot silently land in `default` unnoticed.

## 6. Route-by-route policy

Limits are per minute, capacity equal to the per-minute value (so a full bucket permits one
burst of that size, then refills steadily).

| Policy | Routes | Key | Limit | Rationale |
|---|---|---|---|---|
| `exempt` | `GET /health`; static assets under `/` | — | none | Monitoring must never be throttled; `/health` is a constant-time literal. Static flooding is the reverse proxy's job (P3-06). |
| `login` | `POST /api/admin/auth/login` | client IP **and** a second keyless global bucket | 5/min per IP; 60/min global | Layer above the P1-01 account gate. The global bucket is the backstop when many source IPs are used, and cannot be evaded by key-map eviction. |
| `auth-password` | `POST /api/admin/auth/password` | `session:<adminUserId>` | 5 per 15 min | Closes the gap where `current_password` guessing bypasses the login gate entirely. |
| `auth-session` | `GET /api/admin/auth/session`, `GET /api/admin/auth/sessions` | session id, else IP | 120/min | UI polling headroom; still bounds `validate_admin_session` RPC load. |
| `auth-mutate` | `POST /api/admin/auth/logout`, `DELETE /api/admin/auth/sessions/:id` | session id, else IP | 60/min | Cheap but stateful. |
| `admin-read` | GET/HEAD on all 12 admin groups | `session:<id>` or `apikey` | 300/min | Generous for a human UI including future polling views (D-017). |
| `admin-write` | POST/PATCH/PUT/DELETE on all 12 admin groups | `session:<id>` or `apikey` | 60/min | Human mutation rates are far below this; caps runaway scripts. |
| `admin-expensive` | `POST /api/tasks/import/csv`; `GET /api/reports/task-status` and its legacy alias; `POST /api/admin/alerts/evaluate`; `POST /api/admin/notifications/evaluate` | `session:<id>` or `apikey` | 10/min | Multi-table aggregation, bulk import, and evaluator kicks that can trigger Telegram fan-out. |
| `internal` | `POST /api/notifications/send`, `POST /api/internal/*` | integration identity when resolvable, else IP | 600/min | n8n is a trusted machine caller with legitimate bursts. This is a runaway-loop circuit breaker, not abuse defence. Interacts with P1-02: it caps how fast a loop can push Sotoayam into Telegram 429 handling. |
| `auth-failure` | not a route — consumed on any 401 response | client IP | 30/min | The only protection the `ADMIN_API_KEY` and `INTERNAL_API_KEY` shared secrets have against brute force. |
| `default` | anything unclassified | client IP | 120/min | Fail-safe floor. |

### Telegram surfaces — not applicable

D-006 keeps Telegram on long polling for v1.0. There is **no inbound Telegram HTTP surface** to
rate-limit: `getUpdates` is outbound and already bounded by the P1-02 client. Inbound Telegram
*message* volume is a different control (per-chat command pacing) and is explicitly out of P1-03
scope. If a webhook is ever introduced, it must arrive with its own policy — secret-path plus a
per-IP limit restricted to Telegram's published ranges — and this table must be extended in the
same change.

## 7. Keys, and behaviour behind TRUST_PROXY

### 7.1 Key derivation

- IP keys use `request.ip`, which Fastify derives from `X-Forwarded-For` **only** when
  `trustProxy` is enabled — the existing `TRUST_PROXY` config already controls this correctly.
- IPv6 addresses are truncated to their **/64 prefix** before keying. A single attacker is
  routinely handed a whole /64, so per-address keying is close to useless there.
- Identity keys are `session:<adminUserId>` (not session id — one administrator with ten sessions
  must not get ten times the budget) or the literal `apikey` for the shared-key fallback.

### 7.2 The TRUST_PROXY=false collapse

This is the sharpest operational hazard in the design and must be handled explicitly.

The documented production topology binds `HOST=127.0.0.1` behind a reverse proxy. With
`TRUST_PROXY=false`, **every** request presents as `127.0.0.1`. All IP-keyed buckets then collapse
into a single shared bucket: one noisy client throttles every administrator, and the per-IP
protections become a self-inflicted denial of service. The identical latent issue already affects
P1-01's per-IP `UNKNOWN_EMAIL` branch and its `client_ip` audit column.

Refusing to boot would break existing installs, so:

1. At startup, if `trustProxy === false` **and** the bound host is loopback, log a single
   explicit warning that IP-keyed rate limiting is degenerate and `TRUST_PROXY=true` is required
   behind a reverse proxy.
2. In that state, IP-keyed policies switch to **shared-origin mode**: the limit is multiplied by
   `RATE_LIMIT_SHARED_ORIGIN_FACTOR` (default 10). The app is still protected from raw volume,
   but a single client is far less able to lock out everyone. Identity-keyed policies are
   unaffected and remain exact.
3. `docs/deployment/clean-install.md` and the P3-06 reverse-proxy guidance must state that the
   proxy is required to **overwrite** (not append to) `X-Forwarded-For`, and that
   `TRUST_PROXY=true` without such a proxy is worse than false: the client then controls the
   rate-limit key outright, giving unlimited key cardinality and trivial bypass.

## 8. Response contract

```
HTTP/1.1 429 Too Many Requests
Retry-After: 37
Content-Type: application/json

{ "success": false, "error": { "code": "RATE_LIMITED", "message": "Too many requests" } }
```

- Emitted by throwing `RateLimitedError` extending `AppError(429, "RATE_LIMITED", ...)`, so the
  existing `setErrorHandler` envelope is reused unchanged. The handler sets `Retry-After` from the
  error, exactly as `LoginThrottledError` already does.
- `Retry-After` is always an **integer >= 1** (delta-seconds form, never HTTP-date).
- `RATE_LIMITED` stays **distinct** from P1-01's `LOGIN_THROTTLED`. Both are 429 with
  `Retry-After`, but they mean different things — transport volume versus account cooldown — and
  an operator reading logs must be able to tell them apart. Clients treat both identically.
- The message is constant. It never reveals which bucket fired, whether the account exists,
  whether the credential was valid, or the remaining budget. No enumeration oracle.
- `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` are emitted **only** on
  identity-keyed admin policies, where the caller is already authenticated and a future UI
  benefits from back-pressure signalling. They are omitted on `login`, `auth-failure` and
  `internal` so unauthenticated callers learn nothing about thresholds.
- Rejections are logged at `warn` with policy name and key **class** (`ip` / `session` /
  `apikey`), never the raw key material, and the log itself is sampled (at most one line per
  policy per 10 s) so a flood cannot fill the disk — log amplification is a real DoS path on a
  small VPS.

## 9. Restart behaviour

All counters reset to full on process restart. This is accepted, not merely tolerated:

- The durable guarantee for the highest-value target — password guessing — is already persistent
  in `admin_login_attempts` and survives restart. P1-03 does not weaken it.
- An external attacker cannot induce restarts; if they can, rate limiting is not the failure.
- A crash-looping service is not serving requests anyway, so a reset window is not exploitable in
  practice.
- Systemd restarts and deploys are infrequent and operator-initiated.

The reset window must be stated plainly in the deployment documentation so nobody mistakes
transport rate limiting for a durable lockout mechanism.

## 10. Fail-safe behaviour

Requirement: the limiter must never be the reason the application is unavailable.

- The limiter performs **no I/O and no async work**. There is no store to be unreachable, no
  timeout to tune, and no failure mode inherited from a dependency.
- The hook body is nevertheless wrapped in `try/catch`. On any unexpected error the request is
  **allowed**, one sampled `error` line is logged, and a process counter is incremented. Fail-open
  is correct here precisely because the limiter is not an authorization boundary — authentication
  runs separately and remains fail-closed, so an open limiter degrades to today's behaviour and
  nothing more.
- Memory cannot grow without bound: `RATE_LIMIT_MAX_KEYS` plus sweep-then-evict (§5.2). Sustained
  cap pressure emits a warning, which is itself a useful distributed-attack signal.
- `RATE_LIMIT_ENABLED=false` is a full kill switch. An operator who locks themselves out through
  a misconfiguration — the most likely real-world incident — must have a documented way back in
  without a code change.
- The `onClose` hook clears the sweep timer so repeated `buildApp` calls in tests leak nothing.

## 11. Exemptions and bypass rules

- `GET /health` and static assets: unconditionally exempt.
- **No implicit loopback exemption.** Under `TRUST_PROXY=false` every request *is* loopback, so
  an automatic localhost bypass would silently disable the entire feature in the documented
  production topology. Explicit over implicit.
- `RATE_LIMIT_TRUSTED_IPS` — comma-separated allowlist, **empty by default**. Intended for a
  co-hosted n8n or a monitoring probe. Matching is exact-address (plus /64 for IPv6); no CIDR
  parser in v1. Entries are compared against `request.ip`, so the allowlist is only as trustworthy
  as `TRUST_PROXY` is correct — documented as such.
- **The `ADMIN_API_KEY` fallback is never exempt.** It is the single most brute-forceable
  credential in the product and the thing `auth-failure` exists to protect.
- No per-request bypass header exists, and none may be added. A bypass header is a
  rate-limit-disabling credential in disguise.

## 12. Interaction with the P1-01 login cooldown

They are complementary layers and must both remain:

| | P1-03 rate limit | P1-01 login gate |
|---|---|---|
| Scope | Transport volume | Credential correctness |
| Key | IP / global | Account (`user_id`), and IP for unknown emails |
| Storage | Memory | `admin_login_attempts` |
| Survives restart | No | Yes |
| Runs | `onRequest`, before the handler | Inside the handler, after two RPCs |
| Stops | Spraying, floods, scrypt exhaustion | Targeted per-account guessing |
| Code | `RATE_LIMITED` | `LOGIN_THROTTLED` |

Two binding rules:

1. **A 429 must never be recorded as a login failure.** The P1-03 rejection happens before the
   handler, so `recordLoginFailure` is never reached — this must stay true. If it were violated,
   an attacker could flood `/login` with garbage and drive a legitimate administrator into a
   15-minute account lockout: a rate limiter that manufactures lockouts is worse than none.
   (P1-01 already filters its 5-failure count to `BAD_PASSWORD`/`INACTIVE_USER`, so its own
   `LOCKED_OUT` rows do not compound. Preserve that.)
2. The per-IP `login` limit of 5/min is deliberately **above** the point at which a legitimate
   administrator would be inconvenienced and **below** the point at which scrypt queueing becomes
   dangerous, so in normal operation the P1-01 gate is what a real user meets first.

P1-03 does not change the gate, its thresholds, or its schema.

## 13. Configuration variables

All optional with safe defaults; all bounded and validated in `src/config/env.ts` using the
existing `parseBoolean` / `parseBoundedInteger` helpers, which throw at startup on bad input.

| Variable | Default | Bounds | Meaning |
|---|---|---|---|
| `RATE_LIMIT_ENABLED` | `true` | boolean | Global kill switch |
| `RATE_LIMIT_LOGIN_PER_MINUTE` | `5` | 1–120 | `login`, per IP |
| `RATE_LIMIT_LOGIN_GLOBAL_PER_MINUTE` | `60` | 10–6000 | `login`, keyless backstop |
| `RATE_LIMIT_ADMIN_READ_PER_MINUTE` | `300` | 30–6000 | `admin-read`; `auth-session` is fixed at 120/min |
| `RATE_LIMIT_ADMIN_WRITE_PER_MINUTE` | `60` | 5–1200 | `admin-write`, `auth-mutate` |
| `RATE_LIMIT_ADMIN_EXPENSIVE_PER_MINUTE` | `10` | 1–600 | `admin-expensive` |
| `RATE_LIMIT_INTERNAL_PER_MINUTE` | `600` | 30–20000 | `internal` |
| `RATE_LIMIT_AUTH_FAILURE_PER_MINUTE` | `30` | 3–600 | `auth-failure` penalty bucket |
| `RATE_LIMIT_SHARED_ORIGIN_FACTOR` | `10` | 1–100 | Multiplier applied to IP-keyed limits when the proxy topology is degenerate (§7.2) |
| `RATE_LIMIT_MAX_KEYS` | `10000` | 1000–200000 | Memory bound |
| `RATE_LIMIT_TRUSTED_IPS` | *(empty)* | — | Exact-address allowlist |

`auth-password` (5 per 15 min) is intentionally **not** configurable. It is a security floor with
no legitimate operational reason to raise.

`.env.example` and `docs/deployment/clean-install.md` must gain these entries, with
`TRUST_PROXY=true` called out as required for meaningful IP-keyed limiting behind a proxy.

## 14. Threat and abuse cases

| ID | Threat | Control |
|---|---|---|
| T-1 | Password spraying: one attempt each against many accounts. The P1-01 per-account gate never fires. | `login` per-IP + global bucket |
| T-2 | scrypt exhaustion: concurrent login POSTs, ~32 MB each, unbounded libuv queue → OOM/latency collapse on a 1 GB VPS | `login`, rejected at `onRequest` before scrypt |
| T-3 | `ADMIN_API_KEY` brute force across any of the 12 groups — today entirely unprotected | `auth-failure` per-IP bucket |
| T-4 | `current_password` guessing via `POST /api/admin/auth/password` with a stolen session; not covered by the login gate | `auth-password` |
| T-5 | `INTERNAL_API_KEY` brute force via `/api/notifications/send` | `auth-failure` |
| T-6 | Runaway n8n loop → notification storm → Telegram 429s and delivery-queue growth | `internal`; complements P1-02's bounded retries |
| T-7 | Expensive-read amplification: repeated `/api/reports/task-status`, CSV import, evaluator kicks | `admin-expensive` |
| T-8 | Database amplification: each unauthenticated admin request costs one `validate_admin_session` RPC | Stage 1 rejects before any database call |
| T-9 | Memory exhaustion of the limiter itself via high key cardinality | `RATE_LIMIT_MAX_KEYS`, sweep-then-evict, keyless global login bucket |
| T-10 | Lockout-by-neighbour when `TRUST_PROXY=false` collapses all IPs to `127.0.0.1` | Startup warning + shared-origin mode (§7.2) |
| T-11 | `X-Forwarded-For` spoofing when `TRUST_PROXY=true` without a real proxy → attacker controls the key | Documentation; proxy must overwrite XFF |
| T-12 | Log-flood disk exhaustion from rejection logging | Sampled logging, one line per policy per 10 s |
| T-13 | Operator self-lockout by misconfiguration | `RATE_LIMIT_ENABLED=false` kill switch |
| T-14 | Attacker-forced restart to reset counters | Out of scope; durable protection remains in `admin_login_attempts` (§9) |

Explicitly **not** addressed by P1-03: network-layer volumetric DDoS (reverse proxy / provider),
static asset flooding (P3-06), and per-Telegram-chat command pacing (P1-06 territory).

## 15. Tests and acceptance criteria

`tests/security/rate-limit.test.ts` (unit, pure limiter):

- RL-01 Bucket permits exactly `capacity` immediate requests, refuses the next.
- RL-02 Refill is time-based and monotonic; after `60/limit` seconds exactly one token returns.
- RL-03 `retryAfterSeconds` is always an integer >= 1 and never exceeds the full refill window.
- RL-04 Distinct keys hold independent budgets.
- RL-05 Exceeding `RATE_LIMIT_MAX_KEYS` sweeps full buckets first, then evicts least-recently-used;
  map size never exceeds the cap.
- RL-06 IPv6 addresses in the same /64 map to one key; different /64s do not.

`tests/security/rate-limit-routes.test.ts` (route integration, injected app):

- RL-07 The 6th `POST /api/admin/auth/login` within a minute returns 429, `RATE_LIMITED`, an
  integer `Retry-After`, and the standard error envelope.
- RL-08 **A 429 on login records no login failure**: the injected session repository observes
  zero `recordLoginFailure` calls and zero `evaluateLoginGate` calls for the throttled requests.
  (The binding rule of §12.)
- RL-09 A genuine `LOGIN_THROTTLED` from P1-01 still surfaces as `LOGIN_THROTTLED`, not
  `RATE_LIMITED` — the two layers stay distinguishable.
- RL-10 Repeated 401s against an admin group consume the `auth-failure` bucket and eventually
  return 429, proving the `ADMIN_API_KEY` fallback is rate-limited.
- RL-11 **Manifest**: every registered route resolves to an intended policy; no route in the
  authenticated admin groups or the auth group falls through to `default`. Mirrors the existing
  `admin-route-boundary` manifest approach so a future route cannot be added unprotected.
- RL-12 Two different administrators have independent `admin-write` budgets (identity keyed by
  `adminUserId`), and one administrator's ten sessions share a single budget.
- RL-13 `GET /health` never returns 429 under sustained load.
- RL-14 `admin-read` and `admin-write` budgets are independent of one another.
- RL-15 `POST /api/admin/auth/password` is limited at 5 per 15 minutes independently of `login`.
- RL-16 429 responses carry no `RateLimit-Remaining` on `login` / `internal`, and do carry it on
  identity-keyed admin policies.

`tests/security/rate-limit-failsafe.test.ts`:

- RL-17 A limiter that throws causes the request to be **allowed**, not failed.
- RL-18 `RATE_LIMIT_ENABLED=false` disables all enforcement and registers no hooks.
- RL-19 Building and closing an app twice leaves no active timer (`onClose` clears the sweep).

`tests/env.test.ts` additions:

- RL-20 Each new variable rejects out-of-range and non-numeric values at startup.
- RL-21 `TRUST_PROXY=false` with a loopback host emits the shared-origin warning and applies the
  multiplier to IP-keyed policies only.

### Acceptance criteria

1. No new migration; `supabase/migrations` unchanged and still 16 files with unchanged hashes.
2. No new production dependency.
3. No change to `resolveAdminPrincipal`, CSRF enforcement, cookie handling, or the session schema.
4. All existing tests continue to pass unmodified except where a test legitimately exceeds a new
   limit; any such adjustment must raise the limit **in test configuration**, never in the
   product default, and must be called out in the handoff.
5. Typecheck, build, contract tests, governance checks, and secret scan all pass.
6. `.env.example`, `README.md`, and `docs/deployment/clean-install.md` document every variable and
   the `TRUST_PROXY` requirement.

## 16. Implementation plan for Codex

Ordered, each step independently reviewable.

1. **Limiter core.** `src/http/rate-limit.ts` — `TokenBucketLimiter` with `consume`, `sweep`,
   `size`, `clear`. Pure, no Fastify import, no I/O. Land with RL-01…RL-06.
2. **Policy resolution.** `src/http/rate-limit-policy.ts` — the named policy table from §6,
   built from `AppConfig`; key derivation (IP with IPv6 /64 truncation, `session:<userId>`,
   `apikey`); shared-origin multiplier; trusted-IP allowlist.
3. **Config.** Extend `AppConfig` and `loadConfig` with §13, reusing `parseBoolean` /
   `parseBoundedInteger`. Add the §7.2 startup warning. Land with RL-20, RL-21.
4. **Error type.** `RateLimitedError extends AppError(429, "RATE_LIMITED", ...)` carrying
   `retryAfterSeconds`, in `src/errors.ts`. Set `Retry-After` in the existing `setErrorHandler`
   the same way `LoginThrottledError` is handled in `admin-auth.routes.ts`.
5. **Plugin.** `src/http/rate-limit-plugin.ts` — `onRequest` (stage 1), `onResponse` 401 penalty
   (stage 3), `onClose` timer cleanup, sampled logging. Registered in `buildApp` immediately
   after `fastifyCookie`, before any route registration, and skipped entirely when disabled.
6. **Identity stage.** In `defineAdminRoutes`: the `onRoute` policy stamp, and the identity-keyed
   consume placed **after** `resolveAdminPrincipal` and **before** the CSRF check. Do not alter
   any existing line of principal resolution.
7. **Special-route policies.** Add `config: { rateLimit: ... }` to `login`, `auth-password`,
   `auth-session`, `auth-mutate`, the `admin-expensive` routes, and the two internal groups.
8. **Tests.** RL-07…RL-19 plus the manifest test.
9. **Documentation.** `.env.example`, `README.md` security notes,
   `docs/deployment/clean-install.md`, and the P3-06 reverse-proxy note that the proxy must
   overwrite `X-Forwarded-For`.
10. **Handoff.** Update `AI_HANDOFF.md` and tick `ROADMAP.md` P1-03. Record in `DECISIONS.md` a
    new entry — rate limiting is memory-only and restart-resetting by design, with the durable
    guarantee remaining in `admin_login_attempts` — since that is a product-behaviour decision an
    operator can observe.

Out of scope for P1-03: per-Telegram-chat pacing, network-layer DDoS, adaptive/dynamic limits,
per-customer runtime-tunable limits (P2-01 settings surface), and any distributed store.

## 17. Verdict

**GO.** No migration, no dependency, no auth-architecture change, no multi-tenancy surface, and
no conflict with D-002 through D-015. The design closes four currently unprotected credential
surfaces and one memory-exhaustion vector, and its single significant operational hazard — the
`TRUST_PROXY=false` key collapse — is detected at startup, degraded safely, and documented.
