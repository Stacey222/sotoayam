# ADR P2-02 - Maintainable Sotoayam Message and String Catalog

## Status

Implemented.

Milestone: P2-02  
Owner: Z.AI inventory -> Codex implementation  
Depends on: P0-14, P1-01 through P1-08, P2-00, P2-01, and P2-09

## 1. Context

Sotoayam currently keeps product-authored text beside the behavior that emits or renders it. This is workable but has produced repeated fallback text, mixed Indonesian/English presentation, and large Telegram console modules in which copy and workflow logic are interleaved. The browser uses the same pattern across `public/index.html`, `public/ui-core.js`, `public/app.js`, `public/users.js`, and `public/settings.js`. Reminder notification text is assembled inside `ReminderEvaluatorService`.

Repository governance requires a maintainable message/string catalog in P2-02. D-001 and D-012 keep `Sotoayam` as the fixed v1.0 brand, and the PRD explicitly excludes a full internationalization or white-label engine. P2-01 also keeps message customization outside runtime settings.

This milestone is therefore a source-organization change. It must preserve current HTTP contracts, Telegram workflows, notification content and idempotency, security boundaries, and persisted data.

## 2. Decision

Create a code-owned, statically imported catalog with two runtime-specific entry points under one documented convention:

- `src/messages/catalog.ts` for server-generated customer-facing text and pure formatter functions;
- `public/messages.js` for browser-rendered labels, status text, empty/loading/error states, and pure browser formatter functions.

The split is required by the current build: TypeScript is compiled to `dist`, while the vanilla browser modules are served directly from `public`. P2-02 will not introduce a frontend build step merely to force both runtimes through one physical file. Both entry points use stable semantic keys, readonly values, and pure formatters. Call sites must import catalog values rather than copy catalog-owned literals.

The catalog is not persisted, editable at runtime, localized dynamically, or exposed through a new API.

## 3. Scope

### 3.1 Included server surfaces

- Telegram `/start`, access-denied, unavailable, fallback, and private-chat responses in `src/telegram/bot.ts`.
- Labels, prompts, confirmations, empty states, and error mappings in:
  - `src/telegram/task-console.ts`;
  - `src/telegram/it-console.ts`;
  - `src/telegram/owner-console.ts`.
- Registration result text emitted by `src/services/telegram-registration.service.ts`.
- Sotoayam-generated reminder bodies from `src/services/reminder-evaluator.service.ts`.
- Repeated generic product-facing fallbacks that are emitted through those surfaces.

Dynamic values such as task IDs, safe display names, statuses, counts, deadlines, and policy limits are accepted by named pure formatter functions. The formatter owns punctuation and layout; the caller continues to own domain decisions and supplies only already-authorized data.

### 3.2 Included browser surfaces

- Login/session/network copy in `public/index.html` and `public/ui-core.js`.
- Navigation, headings, loading, empty, unavailable, success, confirmation, and error copy used by `public/app.js`, `public/users.js`, and `public/settings.js`.
- Fixed product labels and status display labels used by the existing dashboard.

Static document structure remains in `public/index.html`. Reusable or state-dependent text moves to `public/messages.js`; HTML-only headings may remain markup constants when moving them would require runtime DOM construction without a maintenance benefit. The inventory test records those deliberate exceptions.

### 3.3 Explicitly excluded

- `AppError` codes and public API response contract redesign.
- PostgreSQL exception markers, constraint names, RPC names, and migration strings.
- Structured log event names and internal diagnostic text.
- User/integration-supplied notification bodies or task content.
- Telegram `callback_data`, commands, dedupe keys, offsets, event IDs, and idempotency inputs.
- Taxonomy display names stored in PostgreSQL.
- Password, session, credential, or security-policy wording changes.
- Runtime message editing, customer overrides, localization negotiation, translation files, white-labeling, or brand replacement.
- Editorial translation or terminology cleanup during extraction. Such changes require a separately reviewed copy change after parity is proven.

## 4. Catalog contract

### 4.1 Keys

Keys describe intent and surface rather than current wording, for example:

- `common.commandUnavailable`
- `common.requestFailed`
- `telegram.privateChatOnly.taskConsole`
- `telegram.task.create.titlePrompt`
- `telegram.owner.activeAlertCount(count, severity)`
- `reminder.task(candidate)`
- `ui.auth.invalidCredentials`
- `ui.users.loading`
- `ui.settings.updateSucceeded`

Keys are internal source identifiers, not API or persistence contracts. Renaming a key is allowed only when all callers and catalog tests change together.

### 4.2 Formatter requirements

- Pure and deterministic: no database, network, clock, environment, or global mutable state.
- Typed on the server. Dynamic values use narrow named inputs rather than arbitrary interpolation maps.
- Return plain text only. They must not produce HTML or assign untrusted values through `innerHTML`.
- Preserve Telegram message length limits and existing explicit truncation.
- Never accept or include passwords, tokens, credential material, hashes, salts, or configuration secrets.
- Preserve current output byte-for-byte in the extraction change, except module line-ending normalization performed by repository tooling.

### 4.3 Ownership boundary

The catalog owns presentation. Services and consoles retain validation, authorization, workflow state, database calls, routing, and choice of which semantic message to emit. The catalog must not inspect roles, permissions, request principals, Telegram updates, or persistence records to choose business behavior.

## 5. Compatibility and security invariants

- Official brand remains exactly `Sotoayam`; no legacy workplace brand may enter catalog values.
- No new browser storage or browser-visible secret/config value.
- No change to P1-01 sessions/CSRF, P1-03 limiting, P1-04 credentials, P1-05 polling, P1-06 fan-out, or P1-08 correlation.
- No change to notification `message`, `source`, event ID, dedupe key, intent, delivery, retry, or recipient semantics.
- No change to Telegram commands, callback payloads, or keyboard navigation.
- No change to response status, error code, envelope, or route authorization.
- Existing tests that assert exact text remain compatibility tests and must pass without updating expected output merely to accommodate extraction.
- Catalog text must not be logged merely because it has moved into a shared module.

## 6. Current inventory and intended modules

| Surface | Current owners | Target |
| --- | --- | --- |
| Telegram dispatch/common fallback | `src/telegram/bot.ts` | `src/messages/catalog.ts` |
| Task console copy | `src/telegram/task-console.ts` | server catalog namespaces/formatters |
| IT console copy | `src/telegram/it-console.ts` | server catalog namespaces/formatters |
| OWNER console copy | `src/telegram/owner-console.ts` | server catalog namespaces/formatters |
| Telegram registration copy | `src/services/telegram-registration.service.ts` | server catalog formatters |
| Reminder notification body | `src/services/reminder-evaluator.service.ts` | server catalog formatter |
| Browser auth/common copy | `public/index.html`, `public/ui-core.js` | `public/messages.js`, with documented static-markup exceptions |
| Dashboard/user/settings state copy | `public/app.js`, `public/users.js`, `public/settings.js` | browser catalog namespaces/formatters |

Production error strings outside these presentation surfaces remain in their route/service modules for P2-02. Moving every API diagnostic into the presentation catalog would blur protocol and UI ownership and create an unrelated cross-module refactor.

## 7. Implementation order

1. Add focused characterization tests for exact current Telegram, reminder, and browser outputs.
2. Add the typed server catalog and move common fallback/registration/reminder text first.
3. Migrate Telegram consoles one at a time: task, IT, then OWNER; run their existing suites after each batch.
4. Add the browser catalog and migrate `ui-core`, dashboard, users, and settings state-dependent copy without changing markup or behavior.
5. Add a bounded inventory checker/test for the files in section 6. It must detect newly duplicated catalog-owned literals while allowing documented dynamic/domain strings and static HTML exceptions; a blanket repository substring ban is not acceptable.
6. Run focused contract tests, the full suite, typecheck, build, secret scan, migration integrity, and `git diff --check`.
7. Update ROADMAP and AI_HANDOFF only after all acceptance tests pass.

## 8. Test matrix

| ID | Proof |
| --- | --- |
| C-01 | Server catalog exports readonly typed semantic groups and pure formatter functions. |
| C-02 | Browser catalog exports the documented semantic groups and contains no executable side effects. |
| C-03 | Telegram `/start`, access denial, private-chat restrictions, unavailable responses, and generic failure output remain exact. |
| C-04 | Task Console menus, prompts, confirmations, validation errors, status transitions, and callback navigation remain exact. |
| C-05 | IT Console menus, user/access prompts, confirmations, and invariant messages remain exact. |
| C-06 | OWNER Console menus, reports, alerts, automation status, empty states, and pagination remain exact. |
| C-07 | Registration responses remain exact for created, already linked, conflict, inactive, and failure outcomes. |
| C-08 | Reminder formatter preserves exact reminder/escalation text and dynamic task/deadline content. |
| C-09 | Reminder dedupe key, event type, stored intent message, recipient expansion, and delivery count remain unchanged. |
| C-10 | Browser login, unauthorized/session-expired, network, loading, empty, unavailable, success, and confirmation flows render the same text. |
| C-11 | Browser code continues to use `textContent`/safe DOM construction for dynamic catalog output and creates no secret-bearing storage. |
| C-12 | Telegram commands and every existing `callback_data` value remain unchanged. |
| C-13 | Inventory enforcement rejects a newly duplicated catalog-owned literal in a designated call-site fixture and accepts documented exceptions. |
| C-14 | Catalog and rendered outputs contain `Sotoayam`, contain no forbidden legacy product branding, and contain no credential/token material. |
| C-15 | HTTP status/error codes/envelopes and route authorization regression suites remain unchanged. |
| C-16 | P1-05 polling, P1-06 fan-out, P1-08 correlation, and notification retry/idempotency suites remain green. |
| C-17 | No migration is added and historical migration hashes/count remain unchanged at 21. |

## 9. Acceptance criteria

P2-02 is complete only when:

1. every included surface in section 3 imports its state-dependent product copy or formatter from the appropriate catalog;
2. no included production path retains an undocumented duplicate of a catalog-owned literal;
3. exact-output characterization and existing behavior tests pass without contract relaxation;
4. no business logic, authorization, idempotency, retry, callback, or persistence behavior changes;
5. no new runtime setting, endpoint, dependency, migration, or browser storage is introduced; and
6. full validation passes.

## 10. Risks and follow-ups

- A single enormous catalog would become less maintainable than colocated copy. The namespace split and pure formatter boundary are required.
- Browser and server catalogs can drift stylistically because the current architecture has no shared build pipeline. C-14 and the documented naming convention mitigate this without adding tooling.
- Existing copy mixes Indonesian and English. P2-02 preserves it intentionally; editorial normalization is a separate review.
- Runtime message customization, notification preferences (P2-03), API documentation (P2-04), and white-label licensing remain separate milestones or explicit non-goals.

## 11. Migration expectation

No database migration. The migration count remains 21 and migrations #1-21 remain byte-identical.
