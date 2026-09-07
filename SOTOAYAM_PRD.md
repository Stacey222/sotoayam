# SOTOAYAM PRD
Version: 1.0-draft  
Status: Active source of truth  
Product: Sotoayam  
Target release: v1.0.0 commercial release candidate  
Basis: Commercial readiness audit dated 2026-09-07 against commit `bd5fdd3`

## 1. Product Vision

Sotoayam is a lightweight commercial operations-automation product for small and growing businesses that need reliable internal notifications, task/event intake, operational reminders, and Telegram-based workflows without expensive infrastructure.

The first commercial release must be:
- safe to install and expose to a customer environment;
- simple to operate on one small VPS;
- configurable without source edits for normal customer-specific settings;
- auditable and recoverable;
- documented well enough that installation and routine operation do not depend on the original developer;
- maintainable without unnecessary infrastructure complexity.

Sotoayam is the product brand. Version 1.0 is not a generic white-label platform by default.

## 2. Product Principles

1. Reliability and security before visual polish.
2. Incremental hardening before architectural rewrites.
3. One deployment per customer for v1.x.
4. One Fastify process + Supabase/PostgreSQL + Telegram long-polling remains the default topology.
5. PostgreSQL remains the queue/lease/dedupe/retry state store.
6. External automation uses Sotoayam contracts; it must not depend on internal database structure.
7. Customer-specific operational taxonomy must be data/configuration, not compiled source.
8. Product branding remains Sotoayam unless a future commercial requirement explicitly introduces white-label licensing.
9. Existing compatibility-sensitive legacy identifiers must be parameterized for fresh installs, not blindly renamed.
10. Optimize for low monthly infrastructure cost.

## 3. Current State

The audit found that the core engine is stronger than the commercial product shell. Strong areas already include:
- RLS deny-all access model for non-service roles;
- SECURITY DEFINER hygiene and service-role-only database access;
- reliable reminder intent deduplication;
- advisory-lock scheduler lease;
- delivery retry state machine;
- route/service/repository layering;
- constant-time key comparison;
- secret scanning and log redaction;
- strict TypeScript baseline;
- 390 passing tests at audit time.

The product is not yet commercially ready because major launch blockers remain in authentication, identity, idempotent notification intake, customer configurability, installation, deployment migration handling, and first-admin onboarding.

## 4. Target Customer

Primary v1 customer:
- Indonesian small/medium business;
- uses Telegram for internal operations;
- may use n8n or another automation source;
- has a small number of administrators/operators;
- prefers low-cost hosting;
- does not have a dedicated DevOps team.

The product must not assume the customer has:
- Kubernetes;
- Redis/Kafka/RabbitMQ;
- enterprise IAM;
- a full-time infrastructure engineer;
- knowledge of the Sotoayam source tree.

## 5. v1.0 Scope

### 5.1 Administration
- Secure admin authentication.
- Signed HTTP-only session.
- Login/logout.
- Real request-level admin identity.
- First-admin bootstrap command.
- Existing permissions model reused where practical.
- Fail-closed authorization applied consistently.

### 5.2 User and Organization Management
- Customer divisions and roles stored as data.
- Installation-time seed/default catalog.
- Admin management of divisions/roles where required for normal operation.
- Legacy identity mapping retained only as a compatibility adapter until safe removal.

### 5.3 Notifications and Delivery
- Every externally-triggered notification is represented by a persisted intent.
- `event_id` / external reference provides idempotency.
- Duplicate intake returns the existing result/intention rather than rebroadcasting.
- Existing reliable delivery pipeline is reused.
- Telegram errors have correct permanent/transient classification.
- Outbound requests use timeouts and bounded retry.
- Broadcast fan-out is bounded.
- Failed deliveries are visible to operators.

### 5.4 Telegram
- Long-polling remains the v1 transport.
- Polling offset/update processing survives restart.
- Bot token remains secret and server-side.
- Registration and operational console behavior remain supported.
- Product must tolerate blocked-bot and rate-limit conditions safely.

### 5.5 Integrations
- n8n remains supported through Sotoayam-owned API contracts.
- Per-integration authentication replaces a single shared integration identity model.
- Integration identity is resolved from credentials, not a caller-asserted header.
- External references are mandatory where idempotency is required.
- ERP remains a future adapter; only the stable boundary is designed in v1 unless a real ERP customer requires implementation.

### 5.6 Configuration
Customer-adjustable values should be configurable without source edits when they are legitimate runtime settings, including as applicable:
- business timezone;
- scheduler cadence;
- alert thresholds;
- operational taxonomy;
- selected product message/config values.

Sotoayam branding itself remains fixed for v1.0. A message catalog may be extracted for maintainability, but full customer white-label branding is not a launch requirement.

### 5.7 Admin UI
Minimum commercial UI:
- login/logout and authenticated state;
- user/access management;
- operational read-only views for critical alerts;
- failed deliveries;
- registered integrations;
- division/role management needed for non-technical operation;
- inline validation;
- clear error banners;
- confirmation for destructive or access-removing actions;
- loading state;
- basic responsive behavior.

A full dashboard covering every API endpoint is not required for v1.0.

### 5.8 Deployment
- Parameterized installer.
- Exact/pinned supported Node runtime.
- No founder-specific deploy account.
- Ordered migration command.
- Deploy pipeline runs migrations safely before release activation.
- Atomic release swap preserved.
- `/ready` is the deployment/rollback acceptance gate.
- Caddy/nginx guidance for customer-facing admin access where needed.
- One small VPS remains the reference deployment.

### 5.9 Backup and Recovery
- Scheduled logical backup.
- Checksum verification.
- Retention policy.
- Documented restore procedure.
- Restore rehearsal before v1.0 release.

### 5.10 Documentation
Required before sale:
- clean installation guide;
- Supabase setup;
- Telegram BotFather setup;
- environment setup;
- migration procedure;
- first-admin setup;
- health/readiness verification;
- API reference;
- troubleshooting runbook;
- upgrade/versioning policy;
- backup/restore guide.

Internal founder/company-specific operational documents must not ship as product documentation.

## 6. Explicit Non-Goals for v1.0

Do not build unless new evidence changes the decision:
- multi-tenancy;
- microservices;
- Kubernetes;
- Redis/RabbitMQ/Kafka;
- enterprise SSO/SAML/OIDC;
- multi-region infrastructure;
- Telegram webhooks;
- full observability stack such as Prometheus/Grafana;
- full i18n framework;
- universal down migrations;
- ERP implementation without a real integration target;
- complete UI for every API route;
- rebranding/white-label engine.

## 7. Security Requirements

v1.0 must satisfy:
- no protected route may fail open;
- startup must refuse unsafe missing required secrets;
- minimum secret strength is enforced;
- authorization is centralized;
- admin actions are tied to a real authenticated user;
- session cookies are signed, HTTP-only, and appropriately scoped;
- auth-bearing routes are rate limited;
- outbound HTTP uses bounded timeouts;
- security headers/CSP are enabled where compatible;
- integration credentials are separable and rotatable;
- secrets are not logged;
- database service-role boundary remains intact;
- security regression tests cover every protected route.

## 8. Reliability Requirements

- duplicate external events do not duplicate delivery;
- persisted intents survive process restart;
- Telegram update handling does not replay actions after restart;
- transient Telegram errors retry with bounded backoff;
- permanent errors do not exhaust retry budgets repeatedly;
- broadcast concurrency respects Telegram constraints;
- `/health` remains liveness-only;
- `/ready` checks dependencies and operational state;
- request/event/intent correlation IDs are traceable;
- scheduler lease behavior remains intact.

## 9. Installation & Upgrade Requirements

A new customer must be able to:
1. provision a small supported VPS;
2. create/configure Supabase;
3. create a Telegram bot;
4. install Sotoayam using documented commands;
5. generate required secrets;
6. run all migrations in order;
7. bootstrap the first admin;
8. enable the intended production features;
9. verify `/ready`;
10. access the admin UI;
11. perform a backup;
12. upgrade to a later release using documented steps.

No step may require knowledge of the founder's personal account, machine, or previous workplace configuration.

## 10. Release Architecture

Reference topology:

External automation / future ERP
        |
        | per-integration credential
        v
Sotoayam Fastify process
  - centralized auth
  - admin session -> normalized user
  - intake -> persisted intent
  - one delivery pipeline
  - Telegram adapter
  - scheduler/evaluators
        |
        | service_role only
        v
Supabase PostgreSQL

Operator browser -> secure session -> Sotoayam admin UI

Deployment: systemd + small VPS + atomic release symlink.

## 11. Commercial Readiness Gates

### Gate A — Security Blockers
- P0 auth bypass closed.
- Secrets mandatory and validated.
- Central auth policy.
- Auth regression suite green.

### Gate B — Reliable Intake
- Notification intent persistence.
- Idempotent replay behavior.
- Delivery pipeline reuse.
- Retry/error classification validated.

### Gate C — Installability
- migration command;
- parameterized installer;
- first-admin bootstrap;
- sane default feature flags;
- clean install documentation.

### Gate D — Productization
- taxonomy as data;
- customer settings surface;
- integration credentials;
- upgrade/versioning process;
- private/internal operational docs removed.

### Gate E — Operations & UX
- login UI;
- critical operational views;
- readiness endpoint;
- backup automation;
- basic responsive/error states;
- troubleshooting guide.

### Gate F — Release Candidate
- clean-room install on hardware/environment not used for development;
- upgrade/rollback rehearsal;
- backup restore rehearsal;
- full security re-audit;
- tag `v1.0.0` with changelog/release notes.

## 12. Acceptance Criteria for v1.0

Sotoayam may be offered to the first paying customer only when:
- every defined P0 blocker is closed;
- no known authentication bypass remains;
- a second admin does not break the HTTP API;
- duplicate notification intake is safe;
- clean installation succeeds from written documentation;
- all migrations apply to an empty target;
- upgrade/rollback path is rehearsed;
- backup restore is rehearsed;
- customer taxonomy no longer requires source editing;
- founder/workplace-specific operational state is absent from product-facing materials;
- required test/typecheck/security checks pass;
- final security review finds no unresolved commercial blocker.

## 13. Definition of Done for Individual Tasks

A task is not done merely because code compiles.

Every implementation task must, where applicable:
1. inspect existing implementation first;
2. preserve established architecture unless the task explicitly changes it;
3. add/update tests for changed behavior;
4. run relevant focused tests;
5. run full tests/typecheck/build when risk warrants;
6. report modified files and behavior;
7. report unresolved risks or assumptions;
8. avoid unrelated refactors;
9. leave the working tree understandable and reviewable;
10. update `ROADMAP.md`, `DECISIONS.md`, or `AI_HANDOFF.md` when the task changes project truth.

## 14. AI Delivery Model

- Claude Code: architecture, security design, integration contracts, broad refactors, high-risk design review.
- Codex: scoped implementation, bug fixes, tests, migrations, debugging, validation.
- Antigravity: adversarial review, architecture challenge, UX critique, clean-room review.
- GitHub Copilot Basic: small inline coding assistance and repetitive local edits.
- Z.AI: low-risk supporting analysis, inventories, documentation preprocessing, log summarization.
- ChatGPT/orchestrator: converts product goals into tasks, assigns agents, writes prompts, challenges outputs, maintains roadmap/source-of-truth consistency.

## 15. Change Control

Any proposal that introduces:
- multi-tenancy;
- a new infrastructure service;
- a new message broker;
- a new authentication platform;
- major database access-model changes;
- a replacement for Supabase;
- a change to compatibility-sensitive legacy identifiers

requires an explicit architectural decision recorded in `DECISIONS.md` before implementation.

## 16. Launch Outcome

The v1.0 launch is successful when Sotoayam can be installed, configured, operated, upgraded, backed up, and recovered by a customer environment without needing hidden founder knowledge, while remaining inexpensive to host and simple to support.
