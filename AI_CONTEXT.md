# SOTOAYAM AI CONTEXT
Purpose: compact shared memory for all coding/review agents.  
Read this before task-specific instructions. Do not treat it as a substitute for inspecting the repository.

## Product
Official product name: `Sotoayam`

Sotoayam is being hardened into a commercial digital product for small/growing businesses. It is no longer an internal workplace project.

## Current Goal
Reach a defensible `v1.0.0` commercial release with:
- secure authentication;
- reliable/idempotent notification handling;
- customer-configurable operational taxonomy;
- clean installation and upgrade path;
- low-cost single-VPS deployment;
- minimum useful admin UI;
- strong documentation and recovery procedures.

## Binding Principles
- Security/reliability before cosmetic work.
- Inspect existing code before modifying.
- Prefer incremental hardening over rewrites.
- Avoid overengineering.
- One instance per customer for v1.x.
- One Fastify process + Supabase/Postgres + Telegram long-polling remains the default.
- Postgres remains the queue/lease/dedupe/retry store.
- External automation must use Sotoayam API/contracts, not database internals.
- Customer taxonomy/configuration should be data, not hardcoded source.
- Sotoayam is the fixed product brand for v1.0; full white-labeling is not a launch requirement.
- Optimize for inexpensive VPS infrastructure.

## Branding Rule
Do not introduce the previous workplace/legacy brand into:
- UI;
- docs;
- prompts;
- examples;
- new identifiers;
- product copy.

Some legacy technical identifiers are compatibility-sensitive. Do NOT blindly rename historical service names, paths, advisory locks, schema contract IDs, storage keys, or migration history. Parameterize for fresh installs where required and preserve compatibility unless a migration plan is approved.

## Strong Existing Foundations — Preserve
- Supabase deny-all RLS model.
- service_role-only access.
- SECURITY DEFINER hardening.
- advisory-lock scheduler lease.
- reminder dedupe behavior.
- notification delivery state machine.
- route -> service -> repository layering.
- constant-time key comparison.
- secret scanning/log redaction.
- strict TypeScript baseline.

## Known Highest-Risk Gaps
- fail-open admin authorization on three route groups;
- no real request-level admin identity;
- no first-admin bootstrap;
- `/api/notifications/send` is not idempotent;
- business taxonomy hardcoded in multiple places;
- migrations are not wired into deployment;
- installer is environment/founder-specific;
- install guide is incomplete;
- UI is too narrow for customer operations.

## AI Responsibilities

### Claude Code
Use for:
- architecture planning;
- security architecture/review;
- endpoint/integration design;
- large cross-module refactors;
- RLS/data-model review;
- ADRs and high-risk design choices.

### Codex
Use for:
- scoped implementation;
- bug fixes;
- tests;
- migrations;
- scripts;
- debugging;
- build/typecheck/validation;
- repetitive repository changes.

### Antigravity
Use for:
- adversarial review;
- second-opinion architecture review;
- UI/UX critique;
- clean-room usability review;
- edge-case/failure-mode discovery.

### GitHub Copilot Basic
Use for:
- local boilerplate;
- small repetitive edits;
- inline completion;
- trivial test scaffolding.

### Z.AI
Use for:
- low-risk supporting analysis;
- string/inventory extraction;
- documentation preprocessing;
- log summarization;
- checklist generation.

## Task Protocol
Before coding:
1. read this file;
2. read the specific task;
3. inspect only relevant source/tests/docs;
4. state critical assumptions if any.

While coding:
- minimize scope;
- do not redesign unrelated areas;
- preserve compatibility unless task explicitly changes it;
- add regression coverage.

Before finishing:
- run relevant validation;
- list modified files;
- explain behavior change;
- list unresolved risks;
- update handoff/roadmap when project truth changed.

## Source of Truth Priority
1. `SOTOAYAM_PRD.md`
2. `DECISIONS.md`
3. `ROADMAP.md`
4. `AI_HANDOFF.md`
5. Current task prompt
6. Existing repo docs/code

If code contradicts PRD/decisions, do not silently “fix” either side. Report the conflict.
