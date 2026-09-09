# SOTOAYAM ROADMAP
Version: 1.0-draft  
Current phase: Phase 1 — Security & Reliability

Legend:
- `[ ]` Not started
- `[~]` In progress
- `[x]` Completed
- `[!]` Blocked

## Phase 0 — Critical Commercial Blockers

### Security/Auth
- [x] P0-01 Close the three fail-open admin authorization checks immediately.
  Owner: Codex
  DoD: unauthorized requests are denied with no configured/wrong key; regression tests added.

- [x] P0-02 Add table-driven auth regression tests across every protected route.
  Owner: Codex

- [x] P0-03 Require a sufficiently strong `ADMIN_API_KEY` at startup during transitional auth.
  Owner: Codex

- [x] P0-04 Centralize admin authorization into one fail-closed plugin/policy.
  Owner: Claude Code design -> Codex implementation -> Antigravity review

### Reliable notification intake
- [x] P0-05 Design persisted notification intent for `/api/notifications/send`.
  Owner: Claude Code
- [x] P0-06 Implement idempotent notification intake + duplicate `event_id` regression test.
  Owner: Codex

### Migration/deployment
- [x] P0-07 Add one ordered `npm run migrate` command.
  Owner: Codex
- [x] P0-08 Wire migrations into deployment before release activation.
  Owner: Codex
- [x] P0-09 Parameterize installer; remove founder-specific deploy account; pin Node version.
  Owner: Codex -> Antigravity review
- [x] P0-10 Separate founder staged-cutover defaults from customer install defaults.
  Owner: Codex

### First installation / configuration
- [x] P0-11 Design first-admin bootstrap flow.
  Owner: Claude Code
- [x] P0-12 Implement `npm run setup` first-admin bootstrap.
  Owner: Codex
- [x] P0-13 Design transition of divisions/roles/customer taxonomy from source to data.
  Owner: Claude Code
- [x] P0-14 Implement install-time taxonomy/config migration with compatibility adapter.
  Owner: Codex -> Antigravity review
  Note: implementation, disposable-PostgreSQL acceptance, and independent adversarial review passed.
- [x] P0-15 Remove private/founder operational state from product documentation.
  Owner: Z.AI inventory -> Codex execute
  Note: customer archive excludes local Supabase project config while retaining all migrations; customer/operator docs are origin-clean except explicitly labeled compatibility identifiers, and internal origin records are labeled historical.

### Documentation
- [x] P0-16 Write and validate clean installation guide.
  Owner: Claude Code author -> Antigravity dry-run
  Note: complete. The customer guide and release packaging passed; a disposable hosted Supabase target matched all 15 migrations; the deterministic data-only restore committed in one transaction across all 28 application tables without `CASCADE` or disabled triggers; restored `FRESH` provenance, `OPERATIONS`, first `ADMIN`, active `SYSTEM_ADMIN`, credentials, and bootstrap marker were verified; and the restored-target application returned `/health` HTTP 200 on Node 24.20.0 with Telegram and schedulers disabled. See `docs/reviews/P0-16-clean-install-rehearsal.md`.

## Phase 1 — Security & Reliability

- [x] P1-01 Real admin identity and signed HTTP-only sessions.
  Owner: Claude Code architecture -> Codex implement
  Note: implemented as the approved opaque, hashed-at-rest PostgreSQL session design with secure HttpOnly cookies, CSRF, bounded expiry/cooldown, truthful session actor resolution, two-SYSTEM_ADMIN compatibility, password rotation/recovery, and the observable Stage A `ADMIN_API_KEY` fallback. One additive migration brings the total to 16; all 15 historical hashes remain unchanged.
- [ ] P1-02 Shared outbound HTTP client: timeout, bounded retry, Telegram 429 handling.
  Owner: Codex
- [ ] P1-03 Rate limiting for auth-bearing routes.
  Owner: Codex
- [ ] P1-04 Per-integration credentials, hashed at rest, with rotation path.
  Owner: Claude Code design -> Codex implement
- [ ] P1-05 Persist Telegram offset and update dedupe.
  Owner: Codex
- [ ] P1-06 Bound/pacing for Telegram fan-out.
  Owner: Codex
- [ ] P1-07 Implement meaningful `/ready`.
  Owner: Claude Code define -> Codex implement
- [ ] P1-08 End-to-end request/event/intent correlation IDs.
  Owner: Codex
- [ ] P1-09 Migration tests against clean throwaway Postgres.
  Owner: Codex
- [ ] P1-10 Adversarial review of auth/intake/integration rewrite.
  Owner: Antigravity

## Phase 2 — Productization

- [ ] P2-01 Define and implement runtime settings surface for legitimate customer settings.
  Owner: Claude Code scope -> Codex implement
- [ ] P2-02 Extract maintainable Sotoayam message/string catalog.
  Owner: Z.AI inventory -> Codex
  Note: full white-label branding is not required for v1.0.
- [ ] P2-03 Normalize notification preferences where necessary.
  Owner: Claude Code design -> Codex migrate
- [ ] P2-04 API reference for all route groups.
  Owner: Z.AI draft -> Claude Code review
- [ ] P2-05 SemVer, CHANGELOG, expand/contract upgrade policy.
  Owner: Claude Code policy -> Codex scripts
- [ ] P2-06 Cross-platform release packaging.
  Owner: Codex
- [ ] P2-07 Automated backup + checksum + retention + restore rehearsal command.
  Owner: Codex -> Antigravity failure review
- [ ] P2-08 Require external reference where automation idempotency depends on it.
  Owner: Codex

## Phase 3 — UI/UX & Operations

- [ ] P3-01 Login/logout/session UI.
  Owner: Codex -> Antigravity critique
- [ ] P3-02 Operational views: critical alerts, failed deliveries, integrations.
  Owner: Claude Code IA -> Codex build -> Antigravity review
- [ ] P3-03 Division/role management UI.
  Owner: Codex
- [ ] P3-04 Inline validation, error banners, destructive-action confirmation.
  Owner: Codex -> Antigravity critique
- [ ] P3-05 Pagination/loading/basic responsive layout.
  Owner: Codex
- [ ] P3-06 Reverse proxy/TLS/firewall deployment guidance.
  Owner: Claude Code -> Codex config
- [ ] P3-07 Customer troubleshooting runbook.
  Owner: Z.AI draft -> Claude Code review
- [ ] P3-08 External free-tier uptime monitoring against `/ready`.
  Owner: Codex

## Phase 4 — Commercial Release Candidate

- [ ] P4-01 Clean-room install on fresh VPS + fresh Supabase + fresh Telegram bot.
  Owner: Antigravity execute/review -> Claude Code triage
- [ ] P4-02 Upgrade + rollback rehearsal with schema change.
  Owner: Codex execute -> Antigravity verify
- [ ] P4-03 Restore drill from automated backup.
  Owner: Codex
- [ ] P4-04 Full security re-audit after auth/integration changes.
  Owner: Claude Code lead -> Antigravity adversarial
- [ ] P4-05 Tag `v1.0.0`, finalize release notes and supported upgrade path.
  Owner: Claude Code

## Launch Gate

Do not accept payment for a production customer until:
- [x] all P0 tasks are closed;
- [ ] no unresolved P0 security/correctness finding remains;
- [ ] clean-room install passes;
- [ ] upgrade/rollback passes;
- [ ] restore drill passes;
- [ ] final security review passes;
- [ ] tests/typecheck/build/security checks are green;
- [ ] product docs contain no private founder/workplace operational state.

## First Execution Order

1. P0-01 — close fail-open checks.
2. P0-02 — regression tests.
3. P0-03 — startup secret requirement.
4. P0-04 — centralized auth.
5. P0-07 — migration command.
6. P0-08 — deployment migration gate.
7. P0-09 — installer parameterization/runtime pin.
8. P0-05 — notification intent design.
9. P0-06 — idempotent intake implementation.
10. P0-11/P0-12 — first-admin bootstrap design + implementation.

The orchestrator may reorder tasks when dependencies or new evidence justify it. Record material changes in `DECISIONS.md`.
