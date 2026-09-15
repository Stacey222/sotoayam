# SOTOAYAM DECISIONS
Status: Active architectural/product decision log.

## D-001 — Product brand
Decision: Official product name is `Sotoayam`.
Status: Final.

The previous workplace brand must not appear in new product-facing work. Compatibility-sensitive legacy technical identifiers may remain temporarily.

## D-002 — Deployment model
Decision: One Sotoayam instance per customer for v1.x.
Status: Final for v1.0.

Reason:
- matches current commercial motion;
- minimizes blast radius;
- preserves strong service-role database boundary;
- avoids premature tenant-scoping rewrite.

Revisit when self-service multi-customer hosting is a real requirement.

## D-003 — Application topology
Decision: Keep one Fastify process on one small VPS.
Status: Final for v1.0.

No microservices or Kubernetes.

## D-004 — Queue and job state
Decision: PostgreSQL remains the queue/lease/dedupe/retry state store.
Status: Final for v1.0.

Do not add Redis, RabbitMQ, or Kafka without evidence that current Postgres mechanisms are insufficient.

## D-005 — Database platform
Decision: Keep Supabase/PostgreSQL.
Status: Final for v1.0.

The existing database access model is an asset and must not be replaced casually.

## D-006 — Telegram transport
Decision: Keep Telegram long-polling for v1.0.
Status: Final.

Do not introduce Telegram webhooks solely for architectural neatness.

## D-007 — Admin authentication target
Decision: Human administrators use their scrypt password identity with opaque random, hashed-at-rest server sessions transported by `HttpOnly`, `Secure`, `SameSite=Strict` cookies and protected by a session-bound CSRF token. This realizes the original signed-session intent while permitting immediate database-backed revocation.
Status: Implemented by P1-01, advanced to Stage B by P1-04, and narrowed for OWNER routes by P2-01. `ADMIN_API_KEY` is optional while the observable compatibility fallback defaults off; explicitly enabling that fallback requires a key of at least 32 characters and emits a startup warning.

P1-01 originally required active `SYSTEM_ADMIN` authority across all administrator route groups. P2-01 is the approved narrow exception: settings and OWNER business routes authorize exact session actors by business permission, while P2-00/P2-09 and every other system-administration surface retain effective-SYSTEM_ADMIN enforcement.

Enterprise IAM/SSO is out of scope.

## D-008 — External integration boundary
Decision: n8n/future ERP must call Sotoayam-owned API contracts.
Status: Final.

External systems must not directly depend on Sotoayam's internal database schema.

## D-009 — Integration credentials
Decision: Machine integrations should have separable credentials and authenticated identity.
Status: Implemented for P1-04.

A caller-provided integration code is never an identity assertion. Machine identity comes from a per-integration 256-bit credential stored only as a SHA-256 digest and checked by a service-only SECURITY DEFINER RPC on every request. Rotation permits at most two overlapping active credentials, revocation is immediate, and P1-03 limits by owning integration rather than credential. The legacy internal key remains an observable, default-enabled Stage A fallback; the administrator shared-key fallback advances to Stage B and defaults off.

## D-010 — Notification reliability
Decision: External notification intake must converge on the existing persisted intent/delivery model.
Status: Approved target.

`event_id`/external reference must prevent duplicate broadcast.

## D-011 — Customer taxonomy
Decision: Divisions/roles/customer-operational taxonomy must become data/configuration rather than compile-time source.
Status: Implemented for P0-14.

Customer divisions and task categories are stored data with stable codes and mutable display names. `SYSTEM_ADMIN` eligibility is attached to an explicitly guarded division capability rather than the literal `IT` code. Fresh setup requires positive `FRESH` lineage and an operator-supplied first division; legacy or absent provenance preserves compatibility adapters. The three baseline role codes remain system-managed, while custom roles and permission-grant editing remain deferred.

## D-012 — Branding configurability
Decision: Sotoayam is a fixed product brand for v1.0.
Status: Final for launch scope.

A maintainable message/string catalog is welcome, but full customer white-label branding is not a commercial blocker and must not delay v1.0.

## D-013 — Legacy technical identifiers
Decision: Do not perform blind rename of compatibility-sensitive historical identifiers.
Status: Final.

For fresh installs, parameterize where useful. Existing installs retain compatibility unless a coordinated migration is approved.

## D-014 — Migration strategy
Decision: Prefer expand/contract compatibility and tested upgrades over universal down migrations.
Status: Approved target.

## D-015 — Infrastructure cost
Decision: Recommendations must default to inexpensive/free-tier-friendly infrastructure where reliability permits.
Status: Final.

Do not add recurring infrastructure services unless the benefit is concrete.

## D-016 — ERP implementation
Decision: ERP implementation is deferred until a real ERP target/customer exists.
Status: Deferred.

Only the integration contract boundary should be prepared now.

## D-017 — UI scope
Decision: v1.0 admin UI should cover high-value customer operations, not every API route.
Status: Final for v1.0.

Priority:
1. secure login/session;
2. user/access management;
3. critical alerts;
4. failed deliveries;
5. registered integrations;
6. division/role management;
7. usable error/loading/confirmation states.

## D-018 — Release proof
Decision: v1.0 cannot launch solely from local tests.
Status: Final.

Required before first paying customer:
- clean-room installation rehearsal;
- upgrade/rollback rehearsal;
- backup restore rehearsal;
- final security review.

## D-019 — Application rate limiting
Decision: Request-volume limiting is an in-process token bucket with bounded memory and restart-resetting counters; no Redis or database counter is used for the single-process v1 architecture.
Status: Implemented for P1-03.

The limiter is an availability boundary and fails open only on its own internal errors; authentication remains independently fail-closed. Durable credential cooldown remains in `admin_login_attempts`. Route policies are attached structurally, administrator fairness is keyed by authenticated user (or the compatibility API-key identity), and 401 responses feed a per-IP penalty that gates later credential attempts. Auth-session reads are fixed at 120/minute; `RATE_LIMIT_ADMIN_READ_PER_MINUTE` applies only to normal admin reads.

## D-020 — Telegram polling durability
Decision: PostgreSQL stores the Telegram polling cursor and the content-free update dedupe ledger.
Status: Implemented for P1-05.

Terminal update status and cursor advancement are one atomic SECURITY DEFINER operation. Batches are rejected wholly if any `update_id` is unusable, otherwise duplicate ids are collapsed and processed in ascending order. SQL clamps the cursor behind every lower `PROCESSING` row. Delivery remains honestly at-least-once because a crash inside the handler can repeat external side effects; retries are bounded and terminal evidence is retained. Malformed batches halt polling rather than inventing an offset, with recovery limited to a forward-only, audited SYSTEM_ADMIN action.

## D-021 — Telegram notification fan-out pacing

Decision: all production notification fan-out shares one dependency-free, in-process concurrency and start-rate gate.
Status: Implemented for P1-06.

The small-VPS default permits three active Telegram notification sends and spaces starts by at least 100 milliseconds. Recipient work uses a fixed worker pool, shutdown prevents queued work from starting, and each outcome remains isolated and input-ordered. Transport retries and Telegram 429 handling remain exclusively in P1-02.

## D-022 — Liveness and readiness separation

Decision: `/health` is pure process liveness; `/ready` is the sanitized fail-closed release/runtime gate.
Status: Implemented for P1-07.

Readiness performs one abortable read-only `load_telegram_polling_state` RPC with no retry, proving database reachability and required schema, then requires admin-session authentication and persisted notification intake wiring. Telegram polling, reminder scheduling, and alert evaluation are non-gating and report only approved inactive warnings. Results use a short in-process cache without stale-while-error; deployment retries temporary startup `503` responses for a bounded warm-up window.

## D-023 — Correlation identifier chain

Decision: operational tracing reuses Fastify request IDs and existing notification identifiers rather than adding a parallel persisted correlation identity.
Status: Implemented for P1-08.

Structured logs use `request_id`, caller/generated `event_id`, internal `notification_event_id`, intent `notification_id`, and `delivery_id` when each becomes available. Immediate HTTP work carries the Fastify request ID in-process; background retry reconstructs durable event correlation through the existing `notification_deliveries -> notifications -> notification_events` relationship. No correlation value changes idempotency, delivery retries, Telegram offset/dedupe, or public response contracts, and secrets/message bodies are excluded from correlation logs.

## D-024 — Effective SYSTEM_ADMIN invariant

Decision: every authority-reducing mutation must preserve at least one effective SYSTEM_ADMIN, and SYSTEM_ADMIN grant/revoke operations require a real session-authenticated effective SYSTEM_ADMIN actor.
Status: Implemented for P2-00.

An effective SYSTEM_ADMIN has an unrevoked assignment, is active, and belongs to an active division whose `grants_system_authority` capability is enabled. Authority revoke, user deactivation or movement, and division deactivation or capability removal serialize with the compatibility advisory lock `gwens_system_admin_invariant` and count this effective state inside the same transaction. The shared `ADMIN_API_KEY` fallback cannot mutate SYSTEM_ADMIN authority. New privileged audit rows identify the real user actor; historical audit rows remain unchanged.

## D-025 — Administrator and user management foundation

Decision: production user management is milestone P2-09 and follows `docs/adr/P2-09-admin-user-management.md`.
Status: Implemented for P2-09.

Only a session-authenticated effective SYSTEM_ADMIN may use this surface; the shared administrator key is excluded. The design reuses normalized users, P1-01 credentials/sessions/password policy, P1-03 route policies, and the P2-00 effective-administrator invariant. Temporary passwords are returned once and must be changed before normal admin use. P2-01 remains unchanged as the runtime-settings and OWNER-actor-redesign milestone.

Migration #20 adds the compatibility-safe `password_change_required` credential state and service-only transactional user-management RPCs. Administrator creation does not pre-create Telegram identity, deactivation revokes target sessions atomically, and every privileged mutation records the resolved human actor.

## D-026 - Runtime settings and OWNER actor boundary

Decision: P2-01 follows `docs/adr/P2-01-runtime-settings-owner-actors.md`.
Status: Implemented for P2-01.

Only business timezone, reminder scheduler cadence, and critical-alert policy become persisted runtime settings. Secrets, trust/network configuration, session and rate-limit controls, worker ownership/enabling, Telegram durability/fan-out controls, readiness, and logging remain deployment-only. Runtime values overlay the validated environment baseline and reload within the single Fastify process.

OWNER remains a permission-based business role, independent from SYSTEM_ADMIN authority. HTTP OWNER operations resolve the exact session user; SYSTEM_ADMIN does not imply OWNER and OWNER does not imply SYSTEM_ADMIN. The shared administrator key cannot mutate settings or OWNER state and may retain only designated-actor GET compatibility. `instance_settings.business_actor_user_id` replaces ambiguous singleton lookup for that compatibility path and is guarded against lockout after designation. P2-00 and P2-09 authorization semantics remain unchanged.
