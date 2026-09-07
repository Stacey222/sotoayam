# P0-04 — Centralized Admin Authorization

Status: Design complete, ready for implementation.
Owner: Claude Code design -> Codex implementation -> Antigravity review.
Inspected: 2026-09-07 against commit `bd5fdd3`.
Shareable page: <https://claude.ai/code/artifact/97316562-7b4d-4552-8d77-7b2816097f66>

This document is the implementation specification for ROADMAP task `P0-04`. Codex should be able to implement the refactor from this file without making additional architectural decisions.

## Problem

SEC-001 (fail-open admin authorization) is patched and covered by 12 route-level regression tests, and `ADMIN_API_KEY` is now mandatory at startup with a 32-character minimum. The remaining problem is architectural: admin authorization is duplicated across route modules as repeated `preHandler` hooks. That duplication produced SEC-001 and remains a regression risk for every future route.

The task is to replace the duplicated guards with one centralized fail-closed mechanism, without changing the external API contract.

## Constraint discovered during inspection

Many existing unit tests register a route group plugin standalone and assert `401`:

```ts
await app.register(reportsRoutes, { service: service(), actorResolver, adminApiKey: "key" });
```

Examples: `tests/reporting/reporting-owner-console.test.ts:80`, `tests/reminders/reminder-notification.test.ts:107`, `tests/ingestion/task-ingestion.test.ts:121`, `tests/alerts/critical-alert-engine.test.ts:93`, `tests/user-management/user-management.test.ts:86`.

Authorization must therefore stay bound to the exported plugin itself, not to composition in `src/app.ts`. Every recommendation below follows from that constraint.

## Current route protection inventory

Read from `src/app.ts:240-310` and every module in `src/routes/`. There are 14 HTTP route registrations across 12 modules, of which exactly 11 are admin-key protected — confirmed independently by `grep -c "adminApiKey:" src/app.ts` = 11. The audit's earlier count of three affected groups covered only the SEC-001 patch set; the duplication is wider.

| Route group | Example path | Current auth | Target auth |
| --- | --- | --- | --- |
| `healthRoutes` | `GET /health` | public | unchanged, never inside an admin scope |
| `usersRoutes` | `GET /api/users` | admin key, local `authorize` fn + hook (`users.routes.ts:16-23`) | `defineAdminRoutes` |
| `adminUserManagementRoutes` | `GET /api/admin/users/catalogs` | admin key, inline duplicate | `defineAdminRoutes` |
| `systemAuthorityRoutes` | `GET /api/admin/system-authority/status` | admin key, inline duplicate | `defineAdminRoutes` (pilot group) |
| `collaborationRulesRoutes` | `GET /api/admin/collaboration-rules` | admin key, inline duplicate | `defineAdminRoutes` |
| `integrationAdministrationRoutes` | `GET /api/admin/integrations` | admin key, inline duplicate | `defineAdminRoutes` |
| `tasksRoutes` | `GET /api/tasks` | admin key + trusted actor per handler | `defineAdminRoutes`, actor logic unchanged |
| `csvImportRoutes` | `POST /api/tasks/import/csv` | admin key, inline duplicate | `defineAdminRoutes` |
| `adminNotificationsRoutes` | `GET /api/admin/notifications/status` | admin key then IT `SYSTEM_ADMIN`, same hook | `defineAdminRoutes` + IT check as second preHandler |
| `reportsRoutes` | `GET /api/reports/content-creator/affiliate-task-status` | admin key, message says "report API key" | `defineAdminRoutes`, message preserved |
| `criticalAlertsRoutes` | `GET /api/alerts` | admin key, message says "alert API key", + OWNER | `defineAdminRoutes`, message preserved |
| `adminCriticalAlertRoutes` | `POST /api/admin/alerts/evaluate` | admin key then IT `SYSTEM_ADMIN`, same hook | `defineAdminRoutes` + IT check as second preHandler |
| `internalTaskIngestionRoutes` | `POST /api/internal/tasks` | internal key + `x-integration-code` capability | unchanged, outside the admin boundary |
| `notificationRoutes` | `POST /api/notifications/send` | internal key, checked inside the handler | unchanged here, see Risks item 3 |
| `@fastify/static` | `GET /`, `/app.js`, `/styles.css` | public admin shell, key held in `sessionStorage` | unchanged, `wildcard: false`, prefix `/` |
| Telegram bot | none (long-polling, no HTTP surface) | chat-identity resolution | untouched |

Classification totals: public 2, admin-protected 11, internal machine-auth 2, Telegram/bot HTTP routes 0. Health/readiness is `/health` only; no `/ready` exists yet (P1-07).

Contract to preserve: header `x-admin-api-key`, compared against `ADMIN_API_KEY` via `secureEqual` (`src/security.ts:3`, SHA-256 digests + `timingSafeEqual`). Rejection is HTTP `401`, code `UNAUTHORIZED`, with three distinct messages currently in use — "Invalid or missing admin API key" (9 groups), "Invalid or missing report API key" (1), "Invalid or missing alert API key" (1).

## Recommended design

A plugin-factory wrapper, `defineAdminRoutes(routes, settings?)`, returning an encapsulated Fastify plugin that installs the one shared admin preHandler before invoking the route body.

```ts
// before — guard #9 of 11, one forgettable line inside a 60-line function
export async function reportsRoutes(app, options) {
  app.addHook("preHandler", async (request) => { /* copy #9 */ });
  // ...
}

// after — protection is a property of the export itself
export const reportsRoutes = defineAdminRoutes<ReportsRoutesOptions>(
  async (app, options) => { /* ... */ },
  { unauthorizedMessage: "Invalid or missing report API key" },
);
```

### Why this beats the alternatives for this repository

**vs. a shared reusable preHandler function.** Deduplicates the comparison but not the attachment. SEC-001 was not merely a bad comparison; it was a pattern where protection is one line an author must remember to write. A shared hook leaves that failure mode fully intact.

**vs. global middleware with a public allowlist.** Actively hazardous here. `/health`, the future `/ready`, the static admin shell at prefix `/`, and both internal endpoints use different credentials and different identity models. Allowlist drift is itself a fail-open path, and the two integrations would break on day one.

**vs. prefix scoping under one guarded parent.** The admin surface is not uniformly under `/api/admin` — `/api/users`, `/api/tasks`, `/api/tasks/import`, `/api/reports` and `/api/alerts` are admin-protected too, and paths cannot change. Worse, the guard would live only in `app.ts`, so the standalone-registration tests listed above would exercise unprotected routes and two of them would fail outright.

**vs. a decorator plus per-route `{ preHandler }`.** Per-route opt-in is the most forgettable variant. It also wants `fastify-plugin`, which would break encapsulation — a hook registered through it leaks upward and becomes the global middleware ruled out above — and adds a dependency the scope constraints discourage.

The wrapper is Fastify-native, needs no new dependency, requires no change to `src/app.ts`, and requires no edit to any existing test: export names, option shapes, statuses, codes and messages are all preserved.

### Encapsulation rule — do not deviate

The returned plugin must **not** be wrapped with `fastify-plugin`. Because these route modules are plain async functions, `app.register()` creates a child context and `addHook("preHandler")` inside it applies to that group's routes only, including anything the body registers through a nested `app.register`. That containment is the mechanism.

## Interface / API

New file `src/auth/admin-authorization.ts` — the only place in `src/` permitted to read `x-admin-api-key`.

```ts
import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppError } from "../errors.js";
import { secureEqual } from "../security.js";

export const ADMIN_API_KEY_HEADER = "x-admin-api-key";
export const DEFAULT_ADMIN_UNAUTHORIZED_MESSAGE = "Invalid or missing admin API key";

/** Marks a plugin produced by defineAdminRoutes so tests can assert protection structurally. */
export const ADMIN_ROUTE_SCOPE = Symbol.for("sotoayam.adminRouteScope");

/**
 * The authenticated admin principal.
 * Phase 1 (P1-01) extends this with real identity (adminUserId, roles, sessionId)
 * and adds a "session" kind. Route bodies read this, never the header.
 */
export interface AdminPrincipal {
  readonly kind: "shared-api-key";
}

/** Options every admin route group must accept. Optional at the type level so existing call
 *  sites and the SEC-001 regression table compile unchanged; absence is denied at runtime. */
export interface AdminAuthorizedRouteOptions {
  adminApiKey?: string;
}

export interface AdminRouteScopeSettings {
  /** Preserves per-group 401 wording, e.g. "Invalid or missing report API key". */
  unauthorizedMessage?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Present only inside an admin route scope; set by the shared guard. */
    adminPrincipal?: AdminPrincipal | null;
  }
}

/** The single implementation of admin credential validation. Fail-closed by construction. */
export function resolveAdminPrincipal(
  request: FastifyRequest,
  options: AdminAuthorizedRouteOptions,
  settings: AdminRouteScopeSettings = {},
): AdminPrincipal {
  const configuredKey = options.adminApiKey;
  const providedKey = request.headers[ADMIN_API_KEY_HEADER];
  if (!configuredKey || typeof providedKey !== "string" || !secureEqual(providedKey, configuredKey)) {
    throw new AppError(401, "UNAUTHORIZED",
      settings.unauthorizedMessage ?? DEFAULT_ADMIN_UNAUTHORIZED_MESSAGE);
  }
  return { kind: "shared-api-key" };
}

/** Wraps a route body in an encapsulated, admin-authorized Fastify scope. */
export function defineAdminRoutes<Options extends AdminAuthorizedRouteOptions>(
  routes: (app: FastifyInstance, options: Options) => Promise<void>,
  settings: AdminRouteScopeSettings = {},
): (app: FastifyInstance, options: Options) => Promise<void> {
  const scope = async (app: FastifyInstance, options: Options): Promise<void> => {
    if (!app.hasRequestDecorator("adminPrincipal")) app.decorateRequest("adminPrincipal", null);
    app.addHook("preHandler", async (request) => {
      request.adminPrincipal = resolveAdminPrincipal(request, options, settings);
    });
    await routes(app, options);
  };
  Object.defineProperty(scope, ADMIN_ROUTE_SCOPE, { value: true, enumerable: false });
  return scope;
}

export function isAdminRouteScope(plugin: unknown): boolean {
  return typeof plugin === "function"
    && (plugin as Record<symbol, unknown>)[ADMIN_ROUTE_SCOPE] === true;
}
```

### Four details Codex must not change

1. **`adminApiKey` stays optional in the type.** Making it required breaks `tests/security/admin-authorization-regression.test.ts:22`, whose conditional spread `...(adminApiKey === undefined ? {} : { adminApiKey })` would no longer typecheck, and `tsconfig.json` includes `tests/**/*.ts`. Startup enforcement already lives in `src/config/env.ts:99`; the runtime check is the defensive second layer.
2. **The `hasRequestDecorator` guard is mandatory**, otherwise nested admin scopes could raise `FST_ERR_DEC_ALREADY_PRESENT`.
3. **`typeof providedKey !== "string"` replaces the current `as string | undefined` cast.** A duplicated header arriving as `string[]` currently reaches `secureEqual` and throws inside `createHash().update()`, producing a 500. It now returns 401. No legitimate client behavior changes.
4. **Secondary authorization stays in the route body.** IT `SYSTEM_ADMIN` and OWNER checks keep their existing codes (`NOTIFICATION_OPERATIONS_FORBIDDEN`, `CRITICAL_ALERT_OPERATIONS_FORBIDDEN`) and run after the key guard.

## Fail-closed guarantees

Runtime behavior of `resolveAdminPrincipal` in all four required states.

| Condition | Behavior |
| --- | --- |
| No key configured at runtime (`options.adminApiKey` falsy) | `401 UNAUTHORIZED`. `!configuredKey` short-circuits before any header is read and before any secondary resolver runs. The absence of a credential can never authorize. |
| Request header absent | `401 UNAUTHORIZED`. `providedKey` is `undefined`, so it is not a string and never reaches the comparison. |
| Request key wrong, or wrong type / duplicated header | `401 UNAUTHORIZED`. `secureEqual` compares SHA-256 digests with `timingSafeEqual`; constant-time behavior preserved exactly and the helper is untouched. |
| Request key correct | Proceeds. Returns `{ kind: "shared-api-key" }`, assigned to `request.adminPrincipal`; the request continues to the group's own checks and handler. |

### Why SEC-001 cannot recur

- **One implementation.** The `!configuredKey ||` condition exists once. There is no eleventh copy to get wrong, and no divergence between copies over time.
- **Attachment is structural, not remembered.** A route body cannot register a route outside its own scope, and the scope always carries the hook. Authorization is applied by the act of exporting the plugin.
- **The guard runs first, unconditionally.** It is always the first `preHandler` in registration order, preserving the tested invariant that a bad key is rejected before `resolveTrustedActor()` is called.
- **Protection travels with the plugin.** Standalone registration in tests is protected identically to production registration. No import is protected in one place and unprotected in another.
- **Locked to one file.** A source-scan test asserts `x-admin-api-key` appears in exactly one `src/` file, blocking the copy-paste path that produced SEC-001.
- **Count parity.** A test asserts the number of `adminApiKey:` registrations in `src/app.ts` (currently 11) equals the tested manifest's length, so wiring a twelfth admin group fails CI until it is covered.

## Migration plan

No flag day. Each step leaves the suite green.

1. **Introduce the primitive.** Create `src/auth/admin-authorization.ts` exactly as specified. Touch nothing else. `npm run typecheck` and `npm test` must stay green with zero behavior change.
2. **Add primitive unit tests.** `tests/security/admin-authorization.test.ts` covering the four states, custom-message propagation, and the duplicated-header case.
3. **Pilot one group: `systemAuthorityRoutes`.** Smallest admin module, no actor resolver, already covered by 4 of the existing 12 regression cases. Convert the export, delete the inline hook and the now-unused `secureEqual` import.
4. **Validate the pilot.** `npm run typecheck && npm test`. The 4 existing `system-authority` cases must pass unmodified, as must every other suite. If anything requires editing an existing test, stop and report — that signals contract drift.
5. **Migrate the remaining ten groups**, one commit-sized batch at a time, running the suite after each:
   - Batch A (plain admin): `usersRoutes`, `adminUserManagementRoutes`, `collaborationRulesRoutes`, `integrationAdministrationRoutes`.
   - Batch B (admin + actor resolution): `tasksRoutes`, `csvImportRoutes` (leaving `internalTaskIngestionRoutes` in the same file untouched), `reportsRoutes` and `criticalAlertsRoutes`, both with their custom messages.
   - Batch C (admin + IT `SYSTEM_ADMIN`): `adminNotificationsRoutes`, `adminCriticalAlertRoutes`. Only the authority check stays in the body's own preHandler, in that order.
6. **Remove the duplicated guards.** Confirm `grep -rn "x-admin-api-key" src/` returns exactly one hit, and no `src/routes/*.ts` imports `secureEqual` except the two internal-key modules. Delete the stale `// TODO SECURITY` comment at `users.routes.ts:17`.
7. **Add the coverage and guard tests.** Extend the regression matrix to all 11 groups and add the boundary suite.
8. **Final validation.** `npm run typecheck`, `npm test`, `npm run check:secrets`, `npm run build`.
9. **Update project truth.** Mark `P0-04` `[x]` in `ROADMAP.md`; replace the SEC-001 section of `AI_HANDOFF.md` with the centralized-auth state and the rule for adding future admin route groups.

`src/app.ts` requires no edits. If Codex finds itself editing it, the wrapper's type signature is wrong.

## Test plan

### A. Primitive — `tests/security/admin-authorization.test.ts` (new)

1. No configured key + correct-looking request key -> throws `AppError` 401 / `UNAUTHORIZED`.
2. Empty-string configured key -> 401, asserted explicitly and not only via `undefined`.
3. Configured key + missing header -> 401.
4. Configured key + wrong header -> 401.
5. Configured key + matching header -> returns `{ kind: "shared-api-key" }`.
6. Duplicated header supplied as `string[]` -> 401, not a 500.
7. `unauthorizedMessage` is used when given; default otherwise.
8. `isAdminRouteScope` is `true` for a wrapped plugin, `false` for a bare async function.

### B. Route-group matrix — `tests/security/admin-authorization-regression.test.ts` (extended only)

Keep the existing table shape and the four `authCases` verbatim; add the eight missing groups to `routeCases`. The existing 12 assertions must continue to pass with no edit to their expectations. Result: 11 groups x 4 conditions = 44 cases.

| Group | Probe |
| --- | --- |
| users | `GET /` |
| admin-user-management | `GET /` |
| system-authority | `GET /status` |
| collaboration-rules | `GET /` |
| integration-administration | `GET /` |
| tasks | `GET /` |
| csv-import | `POST /csv` with a `text/csv` body |
| admin-notifications | `GET /status` |
| reports | `GET /content-creator/affiliate-task-status` |
| critical-alerts | `GET /` |
| admin-critical-alerts | `POST /evaluate?dry_run=true` |

Per group, four conditions: no configured key -> 401; missing request key -> 401; wrong request key -> 401; correct key -> not 401, reaching the body. In all three denial cases assert the downstream stub was not called. For `adminNotifications` and `adminCriticalAlerts`, additionally assert `resolveTrustedActor` was not called on 401 — this pins guard ordering. Message compatibility: "report" wording for reports, "alert" wording for `/api/alerts`, "admin" wording for the other nine.

### C. Boundary and structural guards — `tests/security/admin-route-boundary.test.ts` (new)

1. **Public routes stay public.** `buildApp` with the injected in-memory repository: `GET /health` -> 200 and `GET /` -> 200, both with no key.
2. **Internal machine auth is unaffected.** `POST /api/notifications/send` with `x-internal-api-key` -> not 401; with an admin key instead -> 401. For `internalTaskIngestionRoutes`, the correct internal key reaches the `x-integration-code` check (`INTEGRATION_REQUIRED` / `INTEGRATION_FORBIDDEN` unchanged); an admin key alone -> 401.
3. **Every admin group is structurally protected.** `isAdminRouteScope` is `true` for each manifest entry.
4. **Manifest completeness.** Assert `(appSource.match(/adminApiKey:/g) ?? []).length === adminRouteGroups.length`, currently 11.
5. **Single source of the header.** `x-admin-api-key` appears in exactly one file under `src/`.

No test should assert on hook counts, internal Fastify structures, or the wrapper's implementation shape beyond the `isAdminRouteScope` marker.

## Files likely affected

New:

- `src/auth/admin-authorization.ts`
- `tests/security/admin-authorization.test.ts`
- `tests/security/admin-route-boundary.test.ts`

Modified, route modules:

- `src/routes/users.routes.ts`
- `src/routes/admin-user-management.routes.ts`
- `src/routes/system-authority.routes.ts`
- `src/routes/collaboration-rules.routes.ts`
- `src/routes/integration-administration.routes.ts`
- `src/routes/tasks.routes.ts`
- `src/routes/task-ingestion.routes.ts` (`csvImportRoutes` only)
- `src/routes/admin-notifications.routes.ts`
- `src/routes/reports.routes.ts`
- `src/routes/critical-alerts.routes.ts` (both exports)

Modified, tests and docs:

- `tests/security/admin-authorization-regression.test.ts` (table extended; existing 12 cases unchanged)
- `ROADMAP.md` (P0-04 -> `[x]`)
- `AI_HANDOFF.md`

Expected unchanged — verify, do not edit: `src/app.ts`, `src/security.ts`, `src/config/env.ts`, `src/errors.ts`, `src/routes/health.routes.ts`, `src/routes/notifications.routes.ts`, `public/*`, `package.json`, all other test files.

## Future session compatibility

The boundary is shaped so that P1-01 — real admin identity with signed HTTP-only sessions — changes one file.

- **Route bodies never touch credentials.** After this refactor no route module reads a header, compares a key, or knows what `ADMIN_API_KEY` is. The only thing a route body can observe about authentication is `request.adminPrincipal`.
- **The seam is `resolveAdminPrincipal`.** Phase 1 replaces its body — read the signed cookie, verify the signature, load the admin identity, optionally fall back to the API key during transition — and widens `AdminPrincipal` to a discriminated union such as `{ kind: "shared-api-key" } | { kind: "session"; adminUserId: number; sessionId: string }`. The wrapper, all 11 call sites, every path, every response schema and every handler stay as they are.
- **"Validate admin API key" -> "resolve authenticated admin identity"** is already the shape of the function: it returns a principal rather than a boolean, so identity has somewhere to live from day one.
- **Login routes are naturally excluded.** `POST /api/admin/session` must be reachable without a principal; it is simply a group not wrapped in `defineAdminRoutes`. No allowlist, no exception mechanism, no bypass rule that could quietly widen.
- **Per-group authority checks already sit below it.** The IT and OWNER checks resolve a trusted actor only because no request identity exists. When one does, they consume it instead — a service-layer change per group, not a routing change.
- **Nothing presumes the transport.** Header, cookie, or bearer token are all decisions internal to `resolveAdminPrincipal`.

This task deliberately does not design sessions, `admin_users`, password hashing, CSRF, or cookie policy. All of that is P1-01, and `docs/architecture/authorization-model.md` remains the target model.

## Risks and trade-offs

1. **Shared-secret authentication remains.** One browser-entered key, no per-admin identity, no audit attribution, no revocation, no rate limiting (P1-03). The blast radius of key disclosure is unchanged. This task governs where the check lives, not what it checks.
2. **A brand-new admin module that is neither wrapped nor added to the manifest is still possible.** The wrapper makes the correct path the shortest one, the source-scan blocks the copy-paste path, and count parity catches anything wired through `app.ts` — but an author who writes an unguarded module and also skips the manifest defeats CI. TypeScript cannot express "this export must be an admin scope."
3. **`notifications.routes.ts` validates the internal key inside the handler, not in a hook** (`notifications.routes.ts:13-17`). Correct today for its single route, but structurally the same latent fault as SEC-001: a second route added to that module would be unauthenticated by default. Left out of scope because the brief forbids touching integration credentials and P1-04 reworks this surface. It should be closed at P1-04 at the latest.
4. **`resolveTrustedActor()` is still a process-level trusted actor**, not the requester, so `/api/tasks`, `/api/reports` and `/api/alerts` grant whatever that actor can do to anyone holding the shared key. Resolved by P1-01.
5. **The static admin shell stays public** and the browser stores the key in `sessionStorage` under the legacy name. Correct for now — the shell must load before a key exists — but the admin UI remains publicly enumerable.
6. **Two message variants are carried forward** ("report" / "alert" API key) rather than normalized, to keep this refactor behavior-identical. Normalizing them is a separate, visible API-copy decision.
7. **Marker-symbol coupling.** `isAdminRouteScope` would report `false` for a correctly guarded scope built by hand. Acceptable: the behavioral matrix is the primary guarantee and the marker is corroboration.
8. **`adminApiKey` stays optional in the type**, so the compiler will not catch a forgotten key at a new registration site. Runtime is fail-closed, startup requires the variable, and the matrix covers it — a conscious trade to keep the 12 SEC-001 tests untouched.

## Acceptance criteria

- [ ] `src/auth/admin-authorization.ts` exists and is the only file under `src/` containing the literal `x-admin-api-key`.
- [ ] All 11 admin route groups export plugins produced by `defineAdminRoutes`; no `src/routes/*.ts` file contains an inline admin-key preHandler.
- [ ] `secureEqual` in `src/security.ts` is unmodified and is the only comparison used for the admin key.
- [ ] `src/app.ts` is unmodified — registration sites, prefixes and option shapes byte-identical.
- [ ] No API path, HTTP status, error code or response schema changed. Admin rejections remain `401` / `UNAUTHORIZED` with the existing per-group messages preserved (admin x9, report x1, alert x1).
- [ ] The 12 existing SEC-001 regression tests pass without any edit to their expectations; the matrix is extended to 44 passing cases.
- [ ] Guard ordering proven: for `adminNotificationsRoutes` and `adminCriticalAlertRoutes`, a 401 occurs before `resolveTrustedActor()` is called.
- [ ] `GET /health` and `GET /` remain reachable with no credential.
- [ ] `POST /api/notifications/send` and `POST /api/internal/tasks` still authenticate with `x-internal-api-key`; an admin key alone does not authorize them.
- [ ] Structural guards pass: `isAdminRouteScope` true for every manifest entry; the `adminApiKey:` count in `src/app.ts` equals the manifest length.
- [ ] `npm run typecheck` clean, `npm test` fully green (baseline 390 tests plus new cases, none skipped), `npm run build` succeeds, `npm run check:secrets` clean.
- [ ] No new runtime dependency; no database, RLS, migration, Telegram, integration-credential, deployment or business-logic change.
- [ ] `ROADMAP.md` P0-04 marked `[x]`; `AI_HANDOFF.md` states that new admin route groups must be created with `defineAdminRoutes` and added to the security manifest.
- [ ] Handoff returned in the required format, with P1-01 real admin identity and signed sessions as the single next recommended task.
