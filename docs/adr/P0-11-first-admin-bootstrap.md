# P0-11 — Secure First-Admin Bootstrap for a Fresh Installation

## Status

Accepted and implemented by P0-12.

Owner: Claude Code architecture -> Codex implementation (P0-12) -> Antigravity adversarial review.
Inspected: 2026-09-08 against commit `c670907`, clean working tree, 13 migrations.
Depends on: P0-07/P0-08 (`npm run migrate` and the deployment migration gate), P0-09/P0-10 (parameterized fresh install).
Feeds: P0-12 (implementation), P0-16 (install guide), P1-01 (password + signed HTTP-only session).
Constrained by: D-002, D-003, D-005, D-007, D-011, D-013, D-014, D-015.

## Context

`SOTOAYAM_PRD.md` section 9 requires a new customer to install, migrate, **bootstrap the first admin**, and then reach the admin UI without founder knowledge and without manual database surgery. Gate C blocks commercial release until first-admin bootstrap exists. `ROADMAP.md` schedules P0-11 (this design) and P0-12 (`npm run setup`).

The repository already contains a complete authority model. It does not contain any way to enter it.

Three repository facts shaped every decision below and are stated up front because the task framing does not assume them:

1. **`assign_system_admin` cannot be called on a fresh install.** `supabase/migrations/202608290003_create_it_user_management.sql` requires the candidate to be an *active user in the `IT` division*. `public.users` requires `division_id` and `role_id` to be non-null before `active` may be true. The only code path that creates a `users` row is `register_telegram_identity`, and the only path that activates one is `update_user_access`, which **refuses any user whose `legacy_telegram_user_id` is null**. So today the only reachable route to a first administrator is: register a human on Telegram, activate them into `IT` through the admin API, then grant `SYSTEM_ADMIN`. That is the circular dependency, and it is worse than "no admin exists" — it forces BotFather onto the critical path of creating the product administrator.

2. **`users` has no credential surface at all.** There is no email column, no password column, no session table. `src/auth/admin-authorization.ts` authenticates a *shared key*, not a person: `AdminPrincipal` is `{ kind: "shared-api-key" }` with a comment reserving `adminUserId`/`sessionId` for P1-01. P0-11 must therefore create the credential storage that P1-01 will authenticate against, without implementing authentication.

3. **`users.legacy_telegram_user_id` is nullable and the reconciler tolerates null.** `src/services/identity-reconciliation.service.ts:67-72` only counts a normalized user as `missingLegacy` when its legacy id is non-null and dangling. A Telegram-less administrator therefore does **not** break `npm run check:reconciliation`. This is what makes a Telegram-independent first admin possible without a taxonomy or identity rewrite.

## Current Bootstrap Dependency Chain

Exact state as implemented today.

```text
fresh VPS + fresh Supabase + `npm run migrate`
  |
  |  seeded by 202608290001: 9 divisions (incl. IT), 3 roles, 23 permissions, role_permissions
  |  seeded rows only. public.users = 0. system_authority_assignments = 0.
  v
no administrator exists
  |
  +--> HTTP admin routes still answer, because authentication is a shared key:
  |      src/auth/admin-authorization.ts:41 resolveAdminPrincipal()
  |        header x-admin-api-key == ADMIN_API_KEY  -> AdminPrincipal { kind: "shared-api-key" }
  |      There is no person behind that principal. PRD s7 requires one.
  |
  +--> every route that needs a *person* is dead on a fresh install:
  |      src/repositories/task-users.repository.ts:75 findTrustedAdminActorUser()
  |        select user_id from system_authority_assignments
  |          where authority_code='SYSTEM_ADMIN' and revoked_at is null
  |        ids.length !== 1  ->  503 TASK_ACTOR_UNAVAILABLE
  |      -> task routes, /:id/business-user-code, integration administration
  |         (update_business_user_code, create_task_source_integration,
  |          set/grant/revoke integration capability all call assert_it_system_admin)
  |
  v
to create the administrator you must call assign_system_admin(p_user_id, p_reason, p_actor)
  |  202608290003: perform pg_advisory_xact_lock(hashtextextended('gwens_system_admin_invariant',0))
  |  then REQUIRES:  users.id = p_user_id AND users.active AND divisions.code = 'IT'
  |  the same rule is re-enforced by trigger validate_system_admin_candidate
  |  on INSERT OR UPDATE of system_authority_assignments (so it cannot be bypassed
  |  by writing the table directly, even as service_role).
  v
so an ACTIVE IT USER must already exist
  |  public.users check constraint: (not active or (division_id is not null and role_id is not null))
  v
so a users row must exist AND be activated
  |
  +-- create path (only one):  register_telegram_identity(chat_id, username, first_name)
  |     202608290002, SECURITY DEFINER, service_role only.
  |     Inserts telegram_users (telegram_chat_id NOT NULL UNIQUE) then users then user_channels.
  |     REQUIRES a real Telegram chat id  ->  REQUIRES BotFather + a human /start
  |
  +-- activate path (only one):  update_user_access(...)
        202608290003. Second statement of the function:
          if existing_user.legacy_telegram_user_id is null
            -> raise P0001 'Legacy compatibility mapping is required'
        REQUIRES the Telegram legacy row again.
        Also requires legacy_division_value(code) and legacy_role_value(code) to be
        non-null, i.e. the target division/role must exist in the ORIGIN-COMPANY map.
  v
CIRCLE CLOSED:
  administrator  requires  active IT user
  active IT user requires  update_user_access
  update_user_access requires legacy Telegram mapping
  legacy Telegram mapping requires a Telegram bot and a human who messaged it
  and none of it requires — or produces — a password, an email, or a login identity.
```

Supporting facts confirmed by inspection:

| Fact | Location |
| --- | --- |
| `SYSTEM_ADMIN` is the only authority code; the check constraint forbids others | `202608290001` `system_authority_assignments.authority_code` |
| At most one *active* assignment per user; multiple users may hold it | `system_authority_one_active_assignment_idx` (partial unique on `user_id, authority_code` where `revoked_at is null`) |
| Assignments are never deleted; revocation is a soft `revoked_at` | `revoke_system_admin`, and `protect_final_system_admin` blocks DELETE |
| The last active admin cannot be revoked or deactivated | `protect_final_system_admin`, `protect_final_system_admin_user`, both taking `pg_advisory_xact_lock(hashtextextended('gwens_system_admin_invariant',0))` |
| Audit is append-only and enforced by trigger | `prevent_audit_log_mutation` on `public.audit_logs` |
| Every privileged write is a `security definer` function with `set search_path = ''`, revoked from `public, anon, authenticated`, granted to `service_role` only | `register_telegram_identity`, `update_user_access`, `assign_system_admin`, `intake_notification_event`, `assert_it_system_admin` |
| RLS is enabled on all 23 tables and no policy exists anywhere | every migration; `check-identity-schema.ts` asserts `NO_PUBLIC_POLICIES` |
| Migrations run before release activation and cannot be skipped | `scripts/deploy/deploy-release.sh:70` `npm run migrate` inside the migration gate |
| Runtime config lives in `${APP_ROOT}/shared/.env`, 0640, delivered by `install-env.sh`, mounted as systemd `EnvironmentFile` | `scripts/deploy/install-env.sh`, `deployment-config.sh:118` |
| `loadSupabaseConfig()` needs only `SUPABASE_URL` + a validated service-role/secret key; `loadConfig()` additionally demands the Telegram token, internal key and a >=32 char `ADMIN_API_KEY` | `src/config/env.ts` |
| The release archive ships `dist/src`, **not** `dist/scripts`, and `deploy-release.sh` runs `npm prune --omit=dev`, removing `tsx` | `scripts/deploy/package-release.ps1`, `deploy-release.sh` |
| No `email`, `password`, `credential`, `session` or `bootstrap` identifier exists anywhere in `supabase/migrations` or `src` | repository grep |
| No password-hashing dependency is installed (`bcrypt`, `argon2`, `@node-rs/*` absent); Node is pinned to 24.20.0 | `package.json`, `.node-version` |

## Problem Statement

A fresh Sotoayam installation cannot reach an administrable state without manual SQL against `public.users`, `public.telegram_users`, and `public.system_authority_assignments`, which contradicts PRD section 9 and Gate C, violates the "no undocumented database surgery" requirement, and would be performed by exactly the customers who have no DevOps team.

The mechanism that fixes this must not itself become a permanent, environment-gated, remotely reachable way to mint administrators.

## Goals

1. A fresh install can create **exactly one** first administrator with one documented command, no manual SQL, and no Telegram bot.
2. "Exactly one" is enforced by database state and constraints, not by an application check-then-insert.
3. The first administrator is a real person-shaped identity (name, email, password hash) that P1-01 can authenticate directly, with no re-migration of the credential.
4. Identity creation and authority assignment are one atomic transaction; no partial administrator can exist.
5. After success, the path is inert forever on that database, and re-running it says so explicitly.
6. Bootstrap is not, and cannot be repurposed as, an admin-recovery backdoor.
7. The dependency on origin-company taxonomy is reduced to one explicitly named, single-point compatibility bridge that P0-13/P0-14 deletes.
8. The action is auditable and leaks no secret to logs, argv, shell history, or `audit_logs`.

## Non-Goals

Not designed or implemented here: admin login, session issuance, cookie signing, logout (P1-01); password reset or rotation (P1-01/P1-04); admin recovery / break-glass (deferred, see Recovery); rate limiting (P1-03); enterprise IAM, SSO, MFA; multi-tenancy or tenant scoping (D-002); full role-based HTTP authorization; taxonomy-as-data (P0-13/P0-14); Telegram redesign (D-006); a UI onboarding wizard (P3-01); self-service SaaS provisioning; a second-admin invite flow (the existing `POST /api/admin/system-authority/assign` already covers handover once one admin exists).

## Proposed Bootstrap Surface

**Decision: an operator-run CLI command, `npm run setup`, executed on the installed host. No HTTP surface is added.**

Concretely: a thin entry point at `src/cli/setup.ts` compiled to `dist/src/cli/setup.js`, with the logic in the existing layering (`src/services/first-admin-bootstrap.service.ts` -> `src/repositories/first-admin-bootstrap.repository.ts` -> one RPC).

Why `src/cli/` and not `scripts/`: `package-release.ps1` ships `dist/src` only, and `deploy-release.sh` runs `npm prune --omit=dev`, which deletes `tsx`. A `scripts/setup.ts` run through `tsx` would work on a developer laptop and fail on every real customer VPS. Placing the entry under `src/` makes it part of the existing archive with **no packaging change**.

Why a CLI at all:

| Candidate | Attack surface | Verdict |
| --- | --- | --- |
| **CLI on the host (chosen)** | None reachable from the network. Requires shell access as the service account, which already implies possession of `shared/.env` and therefore the service-role key. Bootstrap grants an attacker nothing they did not already have. | **Chosen** |
| One-time local HTTP setup endpoint | Adds an unauthenticated route to a live, internet-adjacent process. Must be perfectly disabled after use; a disable bug is a permanent remote admin factory. Binding is `127.0.0.1` today, but a future reverse-proxy or bind change silently exposes it. Also races the public internet between `systemctl restart` and the operator's first request. | Rejected |
| Installer-driven (`bootstrap-vps.sh`) | Would put a password into a root-run shell script and its environment, before the database even exists (`bootstrap-vps.sh` runs before migrations). Couples credential creation to OS provisioning. | Rejected |
| Seeded credential in a migration | Puts a secret in Git and in `supabase/migrations`, identical on every customer. Unacceptable. | Rejected |
| Manual SQL runbook | Explicitly forbidden by PRD section 9 and by this task. | Rejected |

The CLI also satisfies the "operator-managed installation" model: it runs once, interactively, by the person who already holds the VPS and Supabase credentials, at a known point in the documented install sequence.

## Bootstrap Eligibility

**The authoritative condition is database state, evaluated inside the bootstrap transaction while holding the existing `gwens_system_admin_invariant` advisory lock. No environment variable, flag, file, or build-time constant participates in the decision.**

Bootstrap is allowed if and only if **all** of the following hold:

```text
G1  select count(*) from public.instance_bootstrap                = 0
      -> this installation has never completed a bootstrap
G2  select count(*) from public.system_authority_assignments      = 0
      -> no authority has EVER been granted on this database,
         active or revoked (rows are never deleted; revocation is soft)
G3  select count(*) from public.admin_credentials                 = 0
      -> no credential identity exists that a bootstrap could shadow
```

Each guard answers a different question, and all three are needed:

- **G2 alone is not enough.** It is the "legacy database" guard (abuse case G) and it is strong because the schema never deletes assignments. But if a future maintenance path ever hard-deleted a revoked row, G2 would silently re-open bootstrap. G1 is the durable, purpose-built record.
- **G1 alone is not enough.** A database migrated forward from an existing installation has admins but no `instance_bootstrap` row. G2 blocks it. This is the case that turns bootstrap into a backdoor if you get it wrong.
- **G3** closes the window where credentials were created by some future path (P1-01 admin invite) without a bootstrap row, and makes "no plaintext, no orphan credential" checkable.

Deliberately **not** guards:

- `count(users) = 0`. A customer may legitimately have Telegram registrations before running setup (someone messaged the bot during install). Requiring an empty `users` table would fail an ordinary install.
- Any `SETUP_ENABLED`-style boolean. It would be exactly the "accidentally enabled forever" failure the task forbids, and it cannot be verified from the database.
- "No *active* `SYSTEM_ADMIN` exists". This is the tempting condition and it is the wrong one: it makes bootstrap self-rearming whenever the last admin is lost, which is precisely the backdoor described in Recovery.

The RPC evaluates G1–G3 itself. The CLI **may** pre-check them for a friendly message, but that pre-check is advisory only and never the authority.

## First Admin Identity Model

The operator supplies exactly three values. Nothing else is required, and Telegram is not among them.

| Field | Required | Source | Validation |
| --- | --- | --- | --- |
| `display_name` | yes | `--name` flag or interactive prompt | trimmed, 1–120 chars, non-empty after trim, no control characters. Matches the `users.display_name` check (`length(trim(...)) > 0`). |
| `email` | yes | `--email` flag or prompt | trimmed, lowercased, <= 254 chars, single `@`, non-empty local and domain parts, at least one dot in the domain, no whitespace or control characters. Stored normalized; uniqueness enforced by index. |
| `password` | yes | interactive no-echo prompt (default), `SOTOAYAM_BOOTSTRAP_ADMIN_PASSWORD` env var, or `--password-file <path>` | see Password / Credential Model |

Explicitly **optional and not collected in P0-12**: Telegram identity. The bootstrap administrator is created with `legacy_telegram_user_id = null` and **no** `user_channels` row. This is safe because:

- `users.legacy_telegram_user_id` is nullable with a unique constraint only on non-null values;
- `reconcileIdentitySnapshots` ignores users whose legacy id is null (`src/services/identity-reconciliation.service.ts:67-72`), so `npm run check:reconciliation` still reports `RESULT = PASS`;
- notification recipient resolution reads `telegram_users` preferences, so an administrator without a Telegram row is simply never a notification recipient — a correct outcome, not a failure.

Two consequences must be documented in the install guide rather than papered over:

1. The bootstrap administrator **cannot be edited through `PATCH /api/admin/users/:id/access`**, because `update_user_access` raises `P0001 'Legacy compatibility mapping is required'` for users with a null legacy id. Their division/role/active state is fixed at creation until P0-13/P0-14 (taxonomy-as-data) or P1-01 relaxes that requirement. For v1.0 this is acceptable and arguably desirable: the product administrator is not a Telegram staff member and should not be reassigned by the staff-management screen.
2. If the customer later wants that same person to also be an operational Telegram user, they register normally via the bot, which creates a **separate** `users` row. Merging the two identities is out of scope for v1.0 and must not be attempted by bootstrap.

The administrator is created **active** (`active = true`), which the `assign_system_admin` candidate rule and the `validate_system_admin_candidate` trigger both require.

## Password / Credential Model

Target architecture per D-007: password hash + signed HTTP-only session. P0-11 designs the hash half only; P1-01 adds verification and sessions and must not need to re-hash or re-migrate.

### Storage

New table `public.admin_credentials`, one row per credentialed administrator, keyed by `users.id`:

```sql
-- design sketch for P0-12
create table public.admin_credentials (
  user_id              bigint primary key references public.users (id),
  email                text not null
                         check (email = lower(trim(email))
                           and length(email) between 3 and 254
                           and email !~ '[[:space:][:cntrl:]]'
                           and email ~ '^[^@]+@[^@.]+(\.[^@.]+)+$'),
  password_algorithm   text not null check (password_algorithm in ('scrypt')),
  password_hash        text not null check (length(password_hash) between 40 and 512),
  password_updated_at  timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create unique index admin_credentials_email_uidx on public.admin_credentials (lower(email));
alter table public.admin_credentials enable row level security;   -- deny-all, no policies
```

`password_algorithm` is a column (not only an embedded prefix) so P1-01 can add `argon2id` beside `scrypt` with an expand/contract migration (D-014) and verify old rows while re-hashing on next successful login.

### Algorithm

**`scrypt` from `node:crypto`.** No new dependency (D-015; `argon2`/`bcrypt` are native modules that would have to compile on every customer VPS and would need to survive `npm ci --ignore-scripts`, which `deploy-release.sh` uses). Parameters:

```text
N = 2^15 (32768), r = 8, p = 1, keylen = 32, salt = 16 random bytes (crypto.randomBytes)
maxmem must be raised to >= 64 MiB: 128 * N * r = 33.5 MB exceeds the 32 MB default
encoded: scrypt$N=32768,r=8,p=1$<salt base64>$<derived key base64>
```

The encoding carries its own parameters so cost can be raised later without a schema change. P1-01 verifies with `crypto.timingSafeEqual`, consistent with `src/security.ts`.

### Password rules

- minimum 12 characters, maximum 256 (no truncation semantics, unlike bcrypt's 72-byte limit);
- rejected if, case-insensitively, it equals or contains the email local part or the display name;
- rejected if it is only whitespace or contains control characters;
- rejected against a small bundled common-password deny list (a few hundred entries, shipped in `src/`; no network call);
- **no composition rules** (NIST SP 800-63B) — length and blocklisting, not character-class theatre;
- confirmed by a second no-echo prompt when read interactively.

### Secret handling

- The password is **never** accepted as a command-line argument. `--password <value>` is not implemented, so it cannot land in shell history, `ps` output, or the systemd journal.
- Accepted sources, in precedence order: `--password-file <path>` (read, then the buffer is overwritten), `SOTOAYAM_BOOTSTRAP_ADMIN_PASSWORD`, interactive no-echo prompt. If none is available and stdin is not a TTY, the CLI exits with `BOOTSTRAP_INPUT_UNAVAILABLE` rather than proceeding.
- **Plaintext never crosses the database boundary.** Hashing happens in Node; the RPC receives only `p_password_algorithm` and `p_password_hash`. No plaintext ever appears in a query string, a PostgREST request body, `pg_stat_activity`, or Supabase logs.
- The plaintext buffer is zeroed after hashing; the CLI prints the created user id, email, division/role codes, and authority — never the password, never the hash, never `SUPABASE_SERVICE_ROLE_KEY`.
- `sanitizeAuditState` (`src/governance/audit-sanitizer.ts`) already redacts keys matching `/password|secret|token|credential|api[_-]?key/i`; the audit payload defined below contains none of those keys in the first place.

## Authority Assignment

**Decision: the first administrator receives `SYSTEM_ADMIN` system authority, plus the minimum business taxonomy the schema requires to be `active` — division `IT`, business role `ADMIN`. It does not receive `OWNER`.**

Rationale from actual repository semantics:

- `SYSTEM_ADMIN` is the only authority code the schema permits (`check (authority_code = 'SYSTEM_ADMIN')`) and is exactly what every privileged path tests: `assert_it_system_admin`, `findTrustedAdminActorUser`, and `docs/architecture/authorization-model.md` ("Authority requires active `SYSTEM_ADMIN` assignment"). Granting it is necessary and sufficient for system administration. **No new role or authority code is invented.**
- `OWNER` is a *business* role, not an authority. `findTrustedOwnerActorUser` (`task-users.repository.ts:86`) demands **exactly one** active user with `roles.code = 'OWNER'` and returns 503 otherwise. Granting `OWNER` to the installer account would consume that singleton slot and then *block* the customer from designating their real business owner without first demoting the bootstrap account — which, per the identity model above, cannot be done through `update_user_access` at all. Granting `OWNER` is therefore actively harmful.
- `ADMIN` is chosen for `role_id` because a role is structurally mandatory (`check (not active or (division_id is not null and role_id is not null))`), and `ADMIN`'s granted permissions are division-scoped viewing and task operations only (`202608290001` `role_permissions`) — no `user.manage`, no `system_authority.manage`, which are granted to no role at all today. It is the smallest role that is not `STAFF`-misleading and does not consume a singleton.
- A useful side effect: creating exactly one `SYSTEM_ADMIN` makes `findTrustedAdminActorUser()` return successfully for the first time on a fresh install, so task routes, `PATCH /:id/business-user-code` and integration administration stop returning `503 TASK_ACTOR_UNAVAILABLE`. Bootstrap is what makes the product usable, not merely loginable.

Sequencing note that must be in the install guide: after P0-12 the credential exists but **there is no login yet**. HTTP admin routes remain guarded by `ADMIN_API_KEY` until P1-01 consumes `admin_credentials` and issues sessions. P0-12 must not be described to customers as "admin login is ready".

## Transaction and Concurrency Semantics

**Decision: one `security definer` RPC, `public.bootstrap_first_admin`, service_role only, pinned `search_path`, following the established convention of `intake_notification_event` and `assign_system_admin`.**

A plpgsql function body is a single transaction: every write below commits together or not at all. There is no application-side multi-step sequence to leave half-done.

```sql
-- design sketch for P0-12; not production code
create or replace function public.bootstrap_first_admin(
  p_display_name       text,
  p_email              text,
  p_password_algorithm text,
  p_password_hash      text
)
returns table (user_id bigint, assignment_id bigint, bootstrapped_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  administrative_division_id bigint;
  administrative_role_id     bigint;
  normalized_email           text;
  created_user_id            bigint;
  created_assignment_id      bigint;
begin
  -- 1. input validation (mirrors, never replaces, CLI validation)
  normalized_email := lower(trim(coalesce(p_email, '')));
  if coalesce(trim(p_display_name), '') = '' or length(trim(p_display_name)) > 120 then
    raise exception using errcode = '22023', message = 'INVALID_DISPLAY_NAME';
  end if;
  if normalized_email !~ '^[^@[:space:][:cntrl:]]+@[^@.[:space:][:cntrl:]]+(\.[^@.[:space:][:cntrl:]]+)+$'
     or length(normalized_email) > 254 then
    raise exception using errcode = '22023', message = 'INVALID_EMAIL';
  end if;
  if p_password_algorithm <> 'scrypt' or coalesce(length(p_password_hash), 0) < 40 then
    raise exception using errcode = '22023', message = 'INVALID_CREDENTIAL_MATERIAL';
  end if;

  -- 2. serialize against every other authority mutation.
  --    Reuses the EXISTING lock key (D-013: historical advisory-lock identifiers are not
  --    renamed), which is also taken by assign_system_admin, revoke_system_admin,
  --    protect_final_system_admin and protect_final_system_admin_user.
  perform pg_advisory_xact_lock(hashtextextended('gwens_system_admin_invariant', 0));

  -- 3. eligibility (G1, G2, G3), evaluated under the lock
  if exists (select 1 from public.instance_bootstrap)
     or exists (select 1 from public.system_authority_assignments)
     or exists (select 1 from public.admin_credentials) then
    raise exception using errcode = 'P0001', message = 'FIRST_ADMIN_ALREADY_EXISTS';
  end if;

  -- 4. taxonomy compatibility bridge — single point, removed by P0-13/P0-14
  select id into administrative_division_id from public.divisions where code = 'IT';
  select id into administrative_role_id     from public.roles     where code = 'ADMIN';
  if administrative_division_id is null or administrative_role_id is null then
    raise exception using errcode = 'P0002', message = 'TAXONOMY_UNAVAILABLE';
  end if;

  -- 5. identity
  insert into public.users (display_name, division_id, role_id, active, legacy_telegram_user_id)
  values (trim(p_display_name), administrative_division_id, administrative_role_id, true, null)
  returning id into created_user_id;

  -- 6. credential (the unique index is the authoritative duplicate-email backstop)
  insert into public.admin_credentials (user_id, email, password_algorithm, password_hash)
  values (created_user_id, normalized_email, p_password_algorithm, p_password_hash);

  -- 7. authority. Direct insert, so the audit source is honest ('first_admin_bootstrap'
  --    rather than assign_system_admin's hardcoded 'admin_api_shared_key').
  --    The validate_system_admin_candidate trigger still enforces
  --    "active user in IT" on this insert, so the invariant is not bypassed.
  insert into public.system_authority_assignments
    (user_id, authority_code, granted_by_user_id, reason)
  values (created_user_id, 'SYSTEM_ADMIN', null,
          'First administrator created by installation bootstrap')
  returning id into created_assignment_id;

  -- 8. permanent, single-row shutdown record
  insert into public.instance_bootstrap (singleton, first_admin_user_id, source)
  values (1, created_user_id, 'first_admin_bootstrap');

  -- 9. audit (append-only; no secrets, no email)
  insert into public.audit_logs
    (actor_type, actor_user_id, action, object_type, object_id, before_state, after_state, source)
  values ('SYSTEM', null, 'FIRST_ADMIN_BOOTSTRAPPED', 'USER', created_user_id::text, null,
    jsonb_build_object(
      'user_id', created_user_id,
      'authority_code', 'SYSTEM_ADMIN',
      'assignment_id', created_assignment_id,
      'division_code', 'IT',
      'role_code', 'ADMIN',
      'credential_algorithm', p_password_algorithm,
      'telegram_identity_present', false),
    'first_admin_bootstrap');

  return query select created_user_id, created_assignment_id, now();
end;
$$;

revoke all on function public.bootstrap_first_admin(text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.bootstrap_first_admin(text, text, text, text) to service_role;
```

### Exactly-once, defended three times

1. **Advisory lock (serialization).** Two concurrent operators serialize on `gwens_system_admin_invariant`. The second one evaluates G1–G3 only after the first has committed, sees the `instance_bootstrap` row, and raises `FIRST_ADMIN_ALREADY_EXISTS`. Reusing the existing key rather than inventing a new one also serializes bootstrap against `assign_system_admin`/`revoke_system_admin` and avoids any lock-ordering deadlock, since no path takes two authority locks.
2. **Single-row primary key (structural).** `instance_bootstrap.singleton` is `smallint primary key check (singleton = 1)` — the table can physically hold at most one row. Even if the lock were removed, a second concurrent insert blocks on the uncommitted key and then fails with `23505`. The CLI maps a `23505` on `instance_bootstrap_pkey` to `FIRST_ADMIN_ALREADY_EXISTS`, not to a generic error.
3. **Unique email index (identity).** `admin_credentials_email_uidx` prevents two credentials for the same address regardless of ordering, mapped to `EMAIL_ALREADY_REGISTERED`.

The application never performs check-then-insert as the deciding step. Any `SystemAuthorityService.status()`-style pre-check in the CLI exists only for message quality.

### Atomicity guarantee

Because steps 5–9 share one transaction, none of the forbidden intermediate states is reachable: a `users` row without `SYSTEM_ADMIN`, a `SYSTEM_ADMIN` without an identity, a credential without a user, or an `instance_bootstrap` row pointing at nothing. A crash at any point before commit rolls back everything, and re-running setup is a clean first attempt (abuse case C).

## Taxonomy Compatibility

The dependency is real and cannot be removed here: `validate_system_admin_candidate` (a **trigger**, so it applies even to direct `service_role` writes) requires the candidate to be an active user whose division code is the literal `'IT'`. Changing that trigger is a taxonomy redesign, which is P0-13/P0-14 and explicitly out of scope.

**The smallest bridge:** step 4 of the RPC — two `select ... where code = 'IT' / 'ADMIN'` lookups against the already-seeded catalog — is the *only* place bootstrap knows anything about taxonomy. It has these properties:

- it takes **no taxonomy parameters**; the CLI carries zero taxonomy knowledge and no operator ever types a division name;
- it **creates no divisions or roles**. It reads what `202608290001` already seeded on every install. Bootstrap does not re-inject origin-company taxonomy;
- it depends on exactly **two** codes (`IT`, `ADMIN`), not on `SALES_GROSIR`, `SHOPEE_LIVE`, `GUDANG`, or any other origin-company division;
- if either code is absent it fails cleanly with `TAXONOMY_UNAVAILABLE` and writes nothing (abuse case J).

**How P0-13/P0-14 removes it:** when divisions/roles become customer data, the eligibility predicate moves from the literal `'IT'` to a capability on the catalog itself — e.g. a `divisions.grants_system_authority` boolean (or an equivalent settings row) that the installation seeds exactly once. At that point:

1. `validate_system_admin_candidate` and `assign_system_admin` test the capability instead of `divisions.code = 'IT'`;
2. step 4 of `bootstrap_first_admin` selects the capability-bearing division and the default administrative role from the same configuration;
3. `update_user_access`'s `legacy_telegram_user_id is null` refusal and its `legacy_division_value`/`legacy_role_value` requirements are relaxed to a compatibility adapter, which also lifts the "bootstrap admin cannot be edited" limitation noted above.

None of that is designed or implemented here. The bridge is deliberately one `select` in one function so P0-14's diff is small and obvious.

## Bootstrap Shutdown

There is no flag to turn off and no code to delete. The path is inert because its precondition is a permanent database fact.

| Operator action after a successful bootstrap | Result |
| --- | --- |
| Runs `npm run setup` again | `FIRST_ADMIN_ALREADY_EXISTS`, exit code 3, **no prompt for a password**, no write of any kind, no partial transaction. The CLI checks eligibility before collecting any secret. |
| Runs it with a different name/email | Identical refusal. Bootstrap never creates a second administrator and never updates the existing one. |
| Runs it after revoking/deactivating the first admin | Identical refusal (G1 is satisfied by `instance_bootstrap`, independent of authority state). See Recovery. |
| Deploys a new release and reruns installation steps | Identical refusal; the deployment migration gate is idempotent and setup is a separate, explicit step. |
| Wants a second administrator | Uses the existing, authenticated `POST /api/admin/system-authority/assign`. That path is unchanged by this ADR. |

The refusal message names the existing administrator's `users.id` and creation timestamp (never the email or any credential material) so the operator can confirm the instance is already provisioned.

## Recovery / Reinstallation Semantics

The two situations must never be conflated:

| Situation | Database evidence | Bootstrap behaviour |
| --- | --- | --- |
| **Fresh empty database** — new customer, migrations just applied | `instance_bootstrap` empty, `system_authority_assignments` empty, `admin_credentials` empty | Allowed. Creates the first administrator. |
| **Existing database, admin lost/disabled/forgotten password** | `instance_bootstrap` has a row, and/or assignments exist (possibly all revoked) | **Refused** with `FIRST_ADMIN_ALREADY_EXISTS`. |
| **Legacy/migrated database with pre-existing `SYSTEM_ADMIN`** | assignments exist, no `instance_bootstrap` row | **Refused** by G2. The installation is already administrable; nothing to bootstrap. |
| **Reinstall of the application onto the same database** | as above | Refused; only the application is reinstalled, and the database is the source of truth. |
| **Genuinely new database for the same customer** (restore-to-new-project, deliberate reset) | all three guards empty | Allowed, and correct — it is a new installation by definition. |

If bootstrap were allowed whenever no *active* administrator existed, then anyone who could reach the setup path could mint an administrator by first removing the existing one. The schema already resists that (`protect_final_system_admin` forbids revoking or deactivating the last one), but eligibility must not depend on that trigger holding forever. Choosing `instance_bootstrap` + "no assignment ever" makes the property independent of authority lifecycle entirely.

**Admin recovery is a separate flow and is deferred.** It has different requirements — proof of continued control of the host, a mandatory audit trail attributing the recovery to an operator, an explicit distinct command name, and ideally a time-boxed token — and it belongs with P1-01, which is where password reset and session invalidation live. Until then, the documented recovery posture for v1.0 is: create a second administrator immediately after installation via `POST /api/admin/system-authority/assign` (the schema's continuity invariant exists precisely to make loss of the sole administrator hard), and the customer's `shared/.env` plus Supabase credentials remain the true break-glass. This ADR does not add a recovery path, and P0-12 must not add one under another name.

## Security Model

- **No new network surface.** No route, no listener, no port. The threat model is "who has a shell as the service account", and that person already reads `shared/.env`.
- **Credential boundary unchanged.** The CLI uses `loadSupabaseConfig()` only — `SUPABASE_URL` plus the validated service-role/secret key. It deliberately does **not** call `loadConfig()`, so bootstrap works before `TELEGRAM_BOT_TOKEN` or a final `ADMIN_API_KEY` have been chosen, and it never reads or logs them.
- **No service-role key in argv or history.** Credentials come from the environment/`shared/.env` in the existing convention (`EnvironmentFile=${APP_ROOT}/shared/.env`, mode 0640). The documented invocation runs as the service account with that env file loaded by the runtime, e.g. `sudo -u <APP_USER> node --env-file=<APP_ROOT>/shared/.env <APP_ROOT>/current/dist/src/cli/setup.js` (Node 24 supports `--env-file`); `npm run setup` is the equivalent from `${APP_ROOT}/current` once the environment is loaded. No `--supabase-key`, `--url`, or `--password` flag exists.
- **RLS posture preserved.** New tables get `enable row level security` and **no policies** — deny-all, service_role-only, matching every existing table.
- **RPC hardening matches convention.** `security definer`, `set search_path = ''`, fully schema-qualified references, `revoke all ... from public, anon, authenticated`, `grant execute ... to service_role`. `anon`/`authenticated` therefore cannot invoke bootstrap even if a PostgREST route were somehow reachable.
- **Triggers remain authoritative.** Bootstrap writes `system_authority_assignments` directly but does not bypass `validate_system_admin_candidate`; the invariant is enforced by the database, not by trust in the caller.
- **Least additional privilege.** Bootstrap grants the operator nothing they lacked: with the service-role key they could already write any table. What changes is that the *supported* way is atomic, validated, audited, and single-use.
- **Secrets never persisted or printed.** See Password / Credential Model. `npm run check:secrets` must stay clean; the deny list and hash encoding contain no secrets.

## Auditability

One audit row, action `FIRST_ADMIN_BOOTSTRAPPED`, `object_type = 'USER'`, `object_id = <new users.id>`, `actor_type = 'SYSTEM'` (there is no prior user to attribute it to — the `check (actor_type <> 'USER' or actor_user_id is not null)` constraint makes `SYSTEM` the only honest choice), `source = 'first_admin_bootstrap'`.

`after_state` contains: `user_id`, `assignment_id`, `authority_code`, `division_code`, `role_code`, `credential_algorithm`, `telegram_identity_present`. It is written inside the same transaction, so an audit record exists if and only if an administrator exists, and `prevent_audit_log_mutation` makes it permanent.

Never logged, never stored, in either the audit row or CLI output: the password, the password hash, the salt, the email (recoverable via `user_id` by an authorized operator; there is no reason to duplicate PII into an immutable log), `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_API_KEY`, `TELEGRAM_BOT_TOKEN`, or any future session secret. The existing `sanitizeAuditState` redaction rules and `scripts/check-secrets.ts` remain in force.

`source = 'first_admin_bootstrap'` is a new, distinct audit source value; it must not reuse `admin_api_shared_key`, which would misattribute the action to the HTTP admin path.

## Error Contract

Every failure is deterministic, named, and leaves the database unchanged. The RPC raises with the stable token as the exception `message`; the repository maps the diagnostic to an `AppError`-style code; the CLI prints the token plus a human sentence and exits with a fixed code.

| Code | Raised when | Postgres signal | Exit | DB state |
| --- | --- | --- | --- | --- |
| `FIRST_ADMIN_ALREADY_EXISTS` | G1, G2 or G3 fails; or `23505` on `instance_bootstrap_pkey` | `P0001` / `23505` | 3 | unchanged |
| `INVALID_EMAIL` | email fails normalization/format/length | `22023` (CLI rejects first) | 2 | unchanged |
| `WEAK_PASSWORD` | < 12 chars, > 256 chars, blocklisted, or contains the name/email local part | CLI-only (plaintext never reaches the DB) | 2 | unchanged |
| `INVALID_DISPLAY_NAME` | empty after trim, > 120 chars, or control characters | `22023` | 2 | unchanged |
| `EMAIL_ALREADY_REGISTERED` | `23505` on `admin_credentials_email_uidx` | `23505` | 4 | unchanged (rolled back) |
| `MISSING_CONFIGURATION` | `SUPABASE_URL` absent, or the key is missing/not a service-role or `sb_secret_` key (`loadSupabaseConfig` throws) | none (pre-flight) | 5 | untouched |
| `INCOMPATIBLE_SCHEMA` | the RPC or a required table does not exist — migrations not applied | `PGRST202`, `PGRST205`, `42883`, `42P01` | 6 | untouched |
| `TAXONOMY_UNAVAILABLE` | the administrative division or role code is absent from the catalog | `P0002` | 7 | unchanged |
| `INVALID_CREDENTIAL_MATERIAL` | algorithm not `scrypt`, or hash shorter than the minimum (indicates a client bug) | `22023` | 2 | unchanged |
| `BOOTSTRAP_INPUT_UNAVAILABLE` | no password source and stdin is not a TTY | none | 2 | untouched |
| `BOOTSTRAP_TRANSACTION_FAILED` | any other database error, including connectivity loss mid-transaction | any | 1 | rolled back by Postgres |

The CLI prints no stack trace by default, and its error output is sanitized by the same rules as the rest of the product.

## Fresh Install Flow

P0-11 adds exactly one step (7) to the sequence already documented in `docs/deployment/vps-production.md`, and no manual SQL anywhere.

```text
1. provision VPS                       sudo bash scripts/deploy/bootstrap-vps.sh   (DEPLOY_USER, APP_ROOT, ...)
2. create Supabase project             operator, out of band
3. generate secrets                    ADMIN_API_KEY >= 32 chars, INTERNAL_API_KEY
4. configure                           .env.example -> shared/.env via scripts/deploy/install-env.sh (0640)
5. package + upload release            scripts/deploy/package-release.ps1  ->  scp
6. deploy + MIGRATE                    scripts/deploy/deploy-release.sh
                                         MIGRATION_GATE=START -> npm run migrate -> MIGRATION_GATE=PASS
                                         then, and only then, the current symlink flips and systemd restarts
                                         schema now contains admin_credentials, instance_bootstrap,
                                         and bootstrap_first_admin()
7. BOOTSTRAP FIRST ADMIN  <-- NEW      as the service account, on the host, once:
                                         npm run setup
                                         prompts: name, email, password (no echo, confirmed)
                                         prints: FIRST_ADMIN_CREATED user_id=<n> email=<addr>
                                                 authority=SYSTEM_ADMIN division=IT role=ADMIN
                                         audit:  FIRST_ADMIN_BOOTSTRAPPED
8. verify runtime                      node scripts/deploy/check-vps-runtime.mjs   (config shape, Node pin, /health)
                                         GET /api/admin/system-authority/status now reports READY
                                         findTrustedAdminActorUser() resolves; task/integration
                                         routes no longer 503 TASK_ACTOR_UNAVAILABLE
9. enable intended workers             polling / reminders / critical alerts, chosen explicitly
10. admin access                       v1.0-with-P0-12: ADMIN_API_KEY (unchanged)
                                       after P1-01:     the bootstrapped email + password, signed
                                                        HTTP-only session; no re-migration needed
11. backup                             existing procedure
```

Telegram bot creation is **not** a prerequisite of step 7. It remains required only for operational Telegram usage (step 9 onward), which is the correct dependency direction.

## Failure Scenario Matrix

| Scenario | Expected State | Safe Result | Reason |
| --- | --- | --- | --- |
| A. Attacker invokes setup after an admin exists | `instance_bootstrap` has 1 row; assignments non-empty | `FIRST_ADMIN_ALREADY_EXISTS`, exit 3, zero writes, no password even collected | Eligibility is database state under an advisory lock; there is no flag to flip and no HTTP path to reach. The attacker would also need shell as the service account, i.e. the service-role key, which already outranks this path. |
| B. Two operators run setup simultaneously | exactly 1 user, 1 credential, 1 assignment, 1 bootstrap row | first commits; second gets `FIRST_ADMIN_ALREADY_EXISTS` | `pg_advisory_xact_lock('gwens_system_admin_invariant')` serializes them; the single-row primary key on `instance_bootstrap` is an independent structural backstop that survives even if the lock were removed. |
| C. Setup process crashes midway (SIGKILL, network loss, VPS reboot) | database unchanged; no partial admin | rerun is a clean first attempt and succeeds | All nine writes are one plpgsql transaction. There is no user without authority, no authority without identity, no credential without a user, and no orphan bootstrap row. |
| D. Service-role credential compromised | attacker already has full database power | bootstrap grants nothing new; on a provisioned instance it still refuses | Bootstrap is not a privilege escalation: service_role can already write every table. Mitigations are the existing ones — 0640 `shared/.env`, non-root service account, no key in argv/history, key rotation. This ADR neither widens nor narrows that boundary. |
| E. Bootstrap command logs sensitive data | logs contain user id, email, taxonomy codes, result token only | no password, hash, salt, service-role key, or admin key is ever emitted | Password never enters argv; plaintext never leaves Node; the audit payload contains no secret-shaped keys; `sanitizeAuditState` and `check:secrets` remain in force. |
| F. Operator accidentally reruns installation (deploy + setup) | migrations are idempotent; bootstrap already complete | deployment succeeds; setup exits 3 with an explicit message naming the existing admin's `users.id` and creation time | The migration gate is already idempotent; setup shutdown is database-derived, so "accidentally still enabled" cannot occur. |
| G. Legacy database already has `SYSTEM_ADMIN` (upgraded existing install) | assignments non-empty, `instance_bootstrap` empty | `FIRST_ADMIN_ALREADY_EXISTS`, exit 3, nothing written | Guard G2 tests *any* assignment ever, active or revoked, so an upgraded installation is never re-bootstrapped and no shadow administrator is minted. |
| H. A user already exists with the same email but no authority | `admin_credentials` non-empty | `FIRST_ADMIN_ALREADY_EXISTS` (G3), or `EMAIL_ALREADY_REGISTERED` if the collision is detected at insert | Bootstrap never adopts, attaches to, or updates an existing identity or credential. `public.users` has no email column today, so the only collision surface is `admin_credentials`, protected by a unique index and rolled back on violation. |
| I. Telegram identity missing / no bot registered yet | admin created with `legacy_telegram_user_id = null`, no `user_channels` row | success; `check:reconciliation` still `RESULT = PASS` | Telegram is a channel, not an identity source (AGENTS.md). The reconciler ignores null legacy ids. Documented limitation: this user cannot be edited via `update_user_access` until P0-13/P0-14. |
| J. Taxonomy/data seeds not configured (division or role code absent) | catalog missing `IT` or `ADMIN` | `TAXONOMY_UNAVAILABLE`, exit 7, zero writes | The bridge lookup happens before any insert and inside the transaction; nothing is left behind. Signals "run migrations / configure taxonomy first", not "invent a division". |
| K. Migrations not applied before setup | RPC or tables absent | `INCOMPATIBLE_SCHEMA`, exit 6 | PostgREST returns `PGRST202`/`PGRST205`; mapped deterministically instead of surfacing a raw driver error. |
| L. Weak or blocklisted password supplied | nothing sent to the database | `WEAK_PASSWORD`, exit 2, re-prompt when interactive | Password policy is enforced before hashing, so plaintext never approaches the boundary. |
| M. `shared/.env` missing or key is not a service-role key | no connection attempted | `MISSING_CONFIGURATION`, exit 5 | `loadSupabaseConfig()` already validates the `sb_secret_` prefix or a JWT with `role = service_role`. |

## Migration / Schema Requirements

One new forward-only migration (D-014, expand-only, no destructive statements), sorting after `202609080001`; the exact 12-digit version is chosen at implementation time, e.g. `supabase/migrations/202609090001_create_first_admin_bootstrap.sql`.

It must contain, and nothing else:

1. `create table public.admin_credentials (...)` as sketched above, `enable row level security`, **no policies**, `updated_at` trigger using the existing `public.set_governance_updated_at()`.
2. `create unique index admin_credentials_email_uidx on public.admin_credentials (lower(email));`
3. ```sql
   create table public.instance_bootstrap (
     singleton           smallint primary key default 1 check (singleton = 1),
     first_admin_user_id bigint not null unique references public.users (id),
     completed_at        timestamptz not null default now(),
     source              text not null check (length(trim(source)) > 0)
   );
   alter table public.instance_bootstrap enable row level security;
   ```
4. `create or replace function public.bootstrap_first_admin(text, text, text, text) ... security definer set search_path = ''`.
5. `revoke all on function public.bootstrap_first_admin(text, text, text, text) from public, anon, authenticated;` and `grant execute ... to service_role;`
6. `comment on` statements for both tables and the function, matching the existing documentation convention.

It must **not**: alter `public.users`, `divisions`, `roles`, `system_authority_assignments`, or any trigger; insert any division, role, permission, user, or authority row; weaken RLS; add a down migration (D-014); or touch `assign_system_admin` / `update_user_access` / `validate_system_admin_candidate`.

Package/runtime requirements:

- `package.json` gains `"setup": "node dist/src/cli/setup.js"` (production path; a `setup:dev` alias may use `tsx src/cli/setup.ts` for local work). It must not depend on `tsx` at runtime, which `npm prune --omit=dev` removes on the VPS.
- No new npm dependency. `scrypt`, `randomBytes` and `timingSafeEqual` come from `node:crypto`; the common-password deny list ships as source in `src/`.
- No change to `package-release.ps1` is expected, because `dist/src` is already packaged. P0-12 must verify this rather than assume it.
- `.env.example` gains a commented note that `SOTOAYAM_BOOTSTRAP_ADMIN_PASSWORD` is a **setup-time-only** variable that must not be written into `shared/.env`; the `REQUIRED` list in `install-env.sh` is unchanged.

## Implementation Plan for P0-12

Ordered, each step independently verifiable.

1. **Migration.** Author the migration above. Run `npm run migrate` against a throwaway Supabase project or local Postgres; confirm `MIGRATION_RESULT = PASS` and that re-running is clean.
2. **Schema checker.** Add `scripts/check-first-admin-bootstrap.ts` and `"check:first-admin-bootstrap"`, following the `check-identity-schema.ts` convention: static assertions over the migration text (`SERVICE_ONLY_RPC`, `PINNED_SEARCH_PATH`, `RLS_ENABLED`, `NO_PUBLIC_POLICIES`, `NON_DESTRUCTIVE`, `SINGLE_ROW_BOOTSTRAP_TABLE`, `NO_PLAINTEXT_PASSWORD_PARAMETER`, `ADVISORY_LOCK_REUSED`) plus live counts (`BOOTSTRAP_COMPLETED`, `ACTIVE_SYSTEM_ADMINS`).
3. **Credential module.** `src/auth/admin-password.ts`: `hashPassword(plaintext)` (scrypt, parameters above, PHC-style encoding) and `validatePasswordPolicy(plaintext, { email, displayName })`. Pure, fully unit-testable, no I/O. A `verifyPassword` may be exported unused for P1-01 or deferred entirely to P1-01 — do not wire it into any route.
4. **Repository.** `src/repositories/first-admin-bootstrap.repository.ts`: one `rpc("bootstrap_first_admin", ...)` call plus the diagnostic-to-code mapping from the Error Contract, in the style of `governance-database-error.ts`.
5. **Service.** `src/services/first-admin-bootstrap.service.ts`: normalize inputs, apply the password policy, hash, call the repository, return a redacted result object. It must be constructible in tests with a fake repository.
6. **CLI.** `src/cli/setup.ts`: parse `--name`, `--email`, `--password-file`; read the password from file/env/no-echo prompt with confirmation; call the service; print the result token and exit with the contract's code. No `--password`, no `--supabase-*` flags, no stack traces.
7. **Wiring.** Add the `setup` script to `package.json`; verify `npm run build` emits `dist/src/cli/setup.js` and that the packaged archive contains it.
8. **Docs.** Add step 7 to `docs/deployment/vps-production.md` with the exact invocation, expected output, and the two documented limitations (no login until P1-01; the bootstrap admin is not editable via `update_user_access`). Feed the same text to P0-16.
9. **Handoff.** Update `AI_HANDOFF.md` and tick P0-11/P0-12 in `ROADMAP.md`.

Out of scope for P0-12, to be rejected in review if it appears: any HTTP route, any session or cookie code, any password-reset path, any change to `admin-authorization.ts`, any modification of existing RPCs or triggers, and any new division/role/permission seed.

## Tests Required for P0-12

Unit and contract tests run under the existing `vitest` setup. Database-backed cases follow the pattern used for migration/schema coverage; those that require a live Postgres go in the P1-09 throwaway-database suite and must be marked, not silently skipped.

| # | Test | Asserts |
| --- | --- | --- |
| 1 | **Empty DB bootstrap succeeds** | Against a freshly migrated database: exit 0; exactly 1 `users` row with `active = true`, IT division, ADMIN role, `legacy_telegram_user_id is null`; 1 `admin_credentials` row; 1 active `SYSTEM_ADMIN`; 1 `instance_bootstrap` row referencing that user. |
| 2 | **Second bootstrap rejected** | Immediately re-running returns `FIRST_ADMIN_ALREADY_EXISTS`, exit 3, and row counts in all four tables are unchanged. Also asserts no password prompt is issued. |
| 3 | **Concurrent bootstrap** | Two simultaneous RPC invocations on separate connections: exactly one succeeds, the other fails with `FIRST_ADMIN_ALREADY_EXISTS` or `23505`; the final state has exactly one administrator. Repeat with the advisory lock removed in a test build to prove the single-row primary key alone still holds the invariant. |
| 4 | **Weak password rejected** | `< 12` chars, `> 256` chars, a blocklisted value, a password equal to or containing the email local part, a password equal to the display name — each rejected with `WEAK_PASSWORD`, exit 2, **and no RPC call is made** (spy on the repository). |
| 5 | **Duplicate identity** | With an `admin_credentials` row already present, bootstrap fails and no new `users`/assignment row is created; a direct duplicate insert into `admin_credentials` violates `admin_credentials_email_uidx`; email case/whitespace variants (`" Admin@Example.COM "`) normalize to the same key. |
| 6 | **Transaction rollback** | Force a failure at each of steps 6, 7 and 8 (duplicate email; a pre-inserted conflicting assignment; a pre-inserted bootstrap row) and assert that `users`, `admin_credentials`, `system_authority_assignments`, `instance_bootstrap` and `audit_logs` are all unchanged — no partial administrator, no orphan audit row. |
| 7 | **No plaintext password anywhere** | The RPC signature accepts no plaintext parameter (static assertion over the migration text); the repository call payload contains only `scrypt` + hash; the hash neither equals nor contains the plaintext; `audit_logs.after_state` contains no `password`/`hash`/`secret` key; CLI stdout/stderr for success and every failure contain neither the plaintext nor the encoded hash; `npm run check:secrets` stays clean. |
| 8 | **Correct authority assignment** | The created assignment has `authority_code = 'SYSTEM_ADMIN'`, `revoked_at is null`, `granted_by_user_id is null`; the user has **no** `OWNER` role; `findTrustedAdminActorUser()` now resolves to exactly that user; `SystemAuthorityService.status()` reports `READY` with `active_count = 1`. |
| 9 | **No Telegram dependency** | Bootstrap succeeds with `telegram_users` and `user_channels` empty and with no `TELEGRAM_BOT_TOKEN` in the environment; afterwards `reconcileIdentitySnapshots` reports `missingLegacy = 0` and `npm run check:reconciliation` yields `RESULT = PASS`. |
| 10 | **Audit record created** | Exactly one `FIRST_ADMIN_BOOTSTRAPPED` row exists, with `actor_type = 'SYSTEM'`, `source = 'first_admin_bootstrap'`, `object_id` equal to the new user id, and an `after_state` containing `authority_code`, `division_code`, `role_code`, `credential_algorithm`, `telegram_identity_present = false` and no email; the row cannot be updated or deleted (`prevent_audit_log_mutation`). |
| 11 | **RPC privileges and RLS** | The migration text contains `security definer`, `set search_path = ''`, `revoke all ... from public, anon, authenticated`, `grant execute ... to service_role`; both new tables have RLS enabled and zero policies; live checks confirm `anon` and `authenticated` cannot execute `bootstrap_first_admin` or select from either table. |
| 12 | **Existing legacy admin blocks bootstrap** | Seed a database that has a `SYSTEM_ADMIN` assignment (an active one, and separately only a revoked one) with **no** `instance_bootstrap` row: bootstrap fails with `FIRST_ADMIN_ALREADY_EXISTS` in both cases and writes nothing. |
| 13 | Missing configuration | No `SUPABASE_URL`, or a non-service-role key, yields `MISSING_CONFIGURATION`, exit 5, with no network call. |
| 14 | Incompatible schema | Against a database without the migration applied, `PGRST202`/`42883` maps to `INCOMPATIBLE_SCHEMA`, exit 6. |
| 15 | Taxonomy unavailable | With the `IT` division (and separately the `ADMIN` role) absent, `TAXONOMY_UNAVAILABLE`, exit 7, no writes. |
| 16 | Password source precedence and non-TTY | `--password-file` beats the env var beats the prompt; no source plus a non-TTY stdin yields `BOOTSTRAP_INPUT_UNAVAILABLE`, exit 2; a `--password` flag does not exist (the argument parser rejects it). |
| 17 | Packaging | The built archive contains `dist/src/cli/setup.js`, and `npm run setup` succeeds in an environment where `tsx` and all devDependencies have been pruned. |

## Rejected Alternatives

1. **One-time local HTTP setup endpoint gated by a token file.** Adds an unauthenticated remote surface to a live process for the sole purpose of avoiding a shell command the operator is already running. Its failure mode is unbounded (a permanent admin factory if the disable logic regresses); the CLI's failure mode is bounded by shell access. It also races the internet during the post-restart window.
2. **`SETUP_ENABLED=true` environment gate.** Explicitly forbidden by the task, and correctly so: it is invisible to the database, survives forever if forgotten, and cannot be audited. Database state is the only honest source of "has this instance been provisioned".
3. **"No active `SYSTEM_ADMIN`" as the eligibility condition.** Simple and wrong: it makes bootstrap self-rearming after admin loss, converting it into the recovery backdoor this ADR is required to prevent.
4. **Application-level check-then-insert in the service.** Not authoritative under concurrency; the task requires database-enforced exactly-once. Retained only as a message-quality pre-check.
5. **Seeding a default administrator in a migration** (fixed email, fixed or generated password printed by the migration). Puts a credential in Git or in migration output, identical across customers, with no operator-chosen password and no way to bind it to a real person.
6. **Reusing `assign_system_admin` inside the bootstrap RPC.** Tempting for DRY, but its audit `source` is hardcoded to `'admin_api_shared_key'`, which would misattribute installation-time bootstrap to the HTTP admin path. The candidate invariant is enforced by `validate_system_admin_candidate` on the insert either way, so nothing is lost by inserting directly with an honest source.
7. **Granting the first admin the `OWNER` business role.** Consumes the `findTrustedOwnerActorUser` singleton, breaks report routes as soon as the customer designates a real owner, and cannot be undone via `update_user_access` for a Telegram-less user.
8. **Creating a new `BOOTSTRAP_ADMIN` authority code or role.** `authority_code` has a check constraint permitting only `SYSTEM_ADMIN`; inventing a code would require altering the constraint, the triggers, and `assert_it_system_admin` — a governance redesign for no gain.
9. **Adding a Telegram identity requirement to bootstrap.** Would keep the BotFather dependency on the critical path of creating the product administrator, contradicting PRD section 9 step ordering and the "do not depend unnecessarily on Telegram" constraint. Nothing in the schema requires it.
10. **Fixing `update_user_access`'s legacy-mapping requirement here** so the bootstrap admin becomes editable. Correct eventually, out of scope now: it is a taxonomy/compatibility change owned by P0-13/P0-14 and would enlarge this migration's blast radius.
11. **`argon2id` via a native dependency.** Better hashing, but a compiled dependency that must build on every customer VPS under `npm ci --ignore-scripts` on a pinned Node. `scrypt` from `node:crypto` is adequate at these parameters, and `password_algorithm` leaves the door open for P1-01.
12. **Placing the CLI in `scripts/`.** Would work on a laptop and fail on every real installation, because the release archive ships only `dist/src` and `tsx` is pruned.

## Open Questions

Only items that could change the design; neither blocks starting P0-12.

1. **Should P0-12 also create a second administrator, or at least warn about single-admin risk?** The schema's continuity invariant makes losing the sole administrator hard but not impossible (host loss, or a forgotten password before P1-01 exists). Recommendation: setup prints a warning directing the operator to create a second administrator via `POST /api/admin/system-authority/assign`, and P0-16 documents it — but no code beyond the warning. Confirm the recommendation, or approve deferring the warning to P1-01.
2. **Does `GET /api/admin/system-authority/status` need its `WAITING_FOR_IT_USER_ASSIGNMENT` label updated?** After P0-12 the accurate pre-bootstrap state is "waiting for first-admin bootstrap". The label is cosmetic and is consumed by `scripts/check-user-management.ts`; changing it is a small, separable follow-up. Recommendation: leave it for P1-01 rather than widening P0-12.

## Acceptance Criteria

P0-11 is accepted when this ADR is approved. P0-12 is accepted when all of the following hold:

1. A fresh VPS + fresh Supabase install reaches an administrable state with **zero manual SQL**, using only the documented commands in Fresh Install Flow.
2. Bootstrap requires **no Telegram bot, no BotFather registration, and no `TELEGRAM_BOT_TOKEN`**; `npm run check:reconciliation` still reports `RESULT = PASS` afterwards.
3. Exactly-one first-admin creation is **enforced by the database** — advisory lock plus a single-row primary key plus a unique email index — and is proven by the concurrency test, including the variant with the advisory lock removed.
4. Identity, credential, authority, shutdown record and audit row are created in **one transaction**; every forced-failure test leaves all five tables unchanged.
5. Re-running setup on a provisioned instance returns `FIRST_ADMIN_ALREADY_EXISTS` with exit code 3, collects no password, and writes nothing — equally for a legacy database whose administrators were all revoked.
6. Eligibility depends on **no environment variable, flag, or file**; removing every Sotoayam environment variable except `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` does not make a provisioned instance bootstrappable again.
7. The password is never accepted in argv, never sent to the database, never written to `audit_logs`, and never printed; `npm run check:secrets` is clean.
8. The credential row is directly usable by P1-01 (email + `password_algorithm` + `password_hash`) with **no re-migration** of the stored value.
9. The first administrator holds `SYSTEM_ADMIN` and not `OWNER`; `findTrustedAdminActorUser()` resolves; `system-authority/status` reports `READY`.
10. Taxonomy coupling is confined to a single lookup of two catalog codes inside `bootstrap_first_admin`, the CLI carries no taxonomy knowledge, and no division or role is created by the bootstrap path.
11. New tables have RLS enabled with no policies; the RPC is `security definer` with a pinned `search_path`, revoked from `public`/`anon`/`authenticated` and granted to `service_role` only.
12. `npm run typecheck`, `npm test`, `npm run check:secrets`, `npm run migrate` and the new `npm run check:first-admin-bootstrap` all pass, and `npm run setup` works in an environment with devDependencies pruned.
13. `docs/deployment/vps-production.md` documents the new step, its exact invocation, its output, and the two known limitations; `ROADMAP.md` and `AI_HANDOFF.md` are updated.
