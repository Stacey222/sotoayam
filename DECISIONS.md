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
Decision: Move from shared browser-entered admin key toward real admin identity using password hash + signed HTTP-only session.
Status: Approved target.

Enterprise IAM/SSO is out of scope.

## D-008 — External integration boundary
Decision: n8n/future ERP must call Sotoayam-owned API contracts.
Status: Final.

External systems must not directly depend on Sotoayam's internal database schema.

## D-009 — Integration credentials
Decision: Machine integrations should have separable credentials and authenticated identity.
Status: Approved target.

A caller-provided integration code must not be the sole identity assertion.

## D-010 — Notification reliability
Decision: External notification intake must converge on the existing persisted intent/delivery model.
Status: Approved target.

`event_id`/external reference must prevent duplicate broadcast.

## D-011 — Customer taxonomy
Decision: Divisions/roles/customer-operational taxonomy must become data/configuration rather than compile-time source.
Status: Approved target.

Legacy mapping may remain as a compatibility adapter during transition.

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
