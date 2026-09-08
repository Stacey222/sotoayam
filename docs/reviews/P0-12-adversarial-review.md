# Adversarial Review — Sotoayam P0-12: First Admin Bootstrap

Reviewer: Antigravity (adversarial review role), completed by ZCode after the original Antigravity reviewer hit its usage quota before issuing a final report.
Reviewed: 2026-09-09 against the working tree at commit `c670907` with the P0-12 changes staged as uncommitted files (see Validation for exact working-tree state).
Method: current repository inspection (migration SQL, CLI, service, repository, password module, checker script, package.json, `dist/` output) plus the recorded evidence from the Codex implementation pass and the partial Antigravity pass. No production code was modified, no migration was modified, no remote write of any kind was performed, and `bootstrap_first_admin` was NOT invoked locally or remotely.

## Verdict

LOLOS

## Executive Summary

P0-12 implements `npm run setup` — a host-local CLI that creates the first administrator through a single `security definer` RPC (`public.bootstrap_first_admin`), exactly as designed in ADR P0-11. The implementation follows the ADR faithfully: CLI → service → repository → RPC layering, scrypt password hashing in Node with the plaintext never crossing the database boundary, exactly-once eligibility enforced inside the RPC under the existing `gwens_system_admin_invariant` advisory lock, one atomic transaction creating user + credential + `SYSTEM_ADMIN` + `instance_bootstrap` marker + audit row, and `IT`/`ADMIN` as the single taxonomy compatibility bridge with no `OWNER` grant.

The exactly-once property is enforced by three independent mechanisms (advisory lock, single-row primary key on `instance_bootstrap`, unique email index on `admin_credentials`). The eligibility predicate inspects **any** historical row in `system_authority_assignments` — active or revoked — not merely active `SYSTEM_ADMIN` rows. This was confirmed directly from the migration SQL (`supabase/migrations/202609090001_create_first_admin_bootstrap.sql:75-79`), and it has a direct consequence for the remote migration incident: the linked remote project already contains at least one `system_authority_assignments` row (`ACTIVE_SYSTEM_ADMINS = 1` from the read-only checker), so the remote instance will fail closed with `FIRST_ADMIN_ALREADY_EXISTS` even though `BOOTSTRAP_COMPLETED = NO`. Bootstrap cannot re-arm there. This was established by static SQL inspection only; the RPC was deliberately not invoked remotely.

Residual concerns are non-blocking: read-only reconciliation confirmed that the remote registry contains `202609080001` and `202609090001`, both align with the repository migration inventory, `ADMIN_CREDENTIAL_COUNT = 0`, and `BOOTSTRAP_COMPLETED = NO`; the two remote migration identities must still never be renamed, rewritten, deleted, or re-timestamped. Database-backed behavior rests on Codex disposable-PostgreSQL evidence only (the Antigravity environment skipped those 8 tests), and there is deliberately no login/session yet — `ADMIN_API_KEY` remains the HTTP admin authentication mechanism until P1-01.

## P0-12 Architecture Verification

Reconstructed from actual source inspection:

```text
npm run setup   (package.json:11 -> node dist/src/cli/setup.js; production path, no tsx)
  |
  v
src/cli/setup.ts: runSetup()
  1. parseArguments(argv)                — only --name / --email / --password-file accepted;
                                           any other flag (including a hypothetical --password)
                                           throws BOOTSTRAP_INPUT_UNAVAILABLE (exit 2)
  2. name/email from flags or interactive prompts (TTY required)
  3. normalizeFirstAdminIdentity()       — trim name (1-120 chars, no control chars);
                                           trim+lowercase email, <=254 chars, strict pattern
  4. createService()                     — loadSupabaseConfig() only (SUPABASE_URL + validated
                                           service-role/secret key); failure -> MISSING_CONFIGURATION (exit 5)
  5. service.getStatus()  PRE-CHECK      — advisory only; if ineligible, refuses BEFORE any
                                           password is collected (FIRST_ADMIN_ALREADY_EXISTS, exit 3),
                                           printing user_id + completed_at, never the email or secrets
  6. collectPassword()                   — precedence: --password-file > SOTOAYAM_BOOTSTRAP_ADMIN_PASSWORD
                                           > interactive no-echo prompt with confirmation;
                                           non-TTY with no source -> BOOTSTRAP_INPUT_UNAVAILABLE (exit 2);
                                           confirmation mismatch -> WEAK_PASSWORD (exit 2)
  |
  v
src/services/first-admin-bootstrap.service.ts: FirstAdminBootstrapService.bootstrap()
  7. normalizeFirstAdminIdentity() again (defensive re-validation)
  8. validatePasswordPolicy()            — length 12-256, no whitespace-only/control chars,
                                           not containing email local part or display name,
                                           not in the bundled common-password deny list;
                                           failure -> WEAK_PASSWORD before any hashing or network I/O
  9. hashPassword()                      — scrypt N=32768, r=8, p=1, keylen=32, salt=16 random
                                           bytes, maxmem=64 MiB; encoded
                                           "scrypt$N=32768,r=8,p=1$<salt b64>$<key b64>";
                                           plaintext buffer zeroed after hashing
  |
  v
src/repositories/first-admin-bootstrap.repository.ts: SupabaseFirstAdminBootstrapRepository.bootstrap()
 10. client.rpc("bootstrap_first_admin", { p_display_name, p_email,
         p_password_algorithm: "scrypt", p_password_hash })     — ONLY the hash crosses the boundary;
                                                                  no plaintext parameter exists
  |
  v
public.bootstrap_first_admin  (migration 202609090001, security definer, search_path = '')
 11. input re-validation                 — INVALID_DISPLAY_NAME / INVALID_EMAIL /
                                           INVALID_CREDENTIAL_MATERIAL (22023)
 12. pg_advisory_xact_lock(hashtextextended('gwens_system_admin_invariant', 0))
                                           — the EXISTING authority lock, shared with
                                             assign_system_admin / revoke_system_admin / protect_*
 13. eligibility under the lock          — exists(instance_bootstrap) OR
                                             exists(system_authority_assignments)  [ANY row,
                                             active or revoked] OR exists(admin_credentials)
                                             -> FIRST_ADMIN_ALREADY_EXISTS (P0001)
 14. taxonomy bridge                     — select divisions where code='IT',
                                             roles where code='ADMIN'; absent -> TAXONOMY_UNAVAILABLE (P0002)
 15. insert users                        — active, IT division, ADMIN role, legacy_telegram_user_id = null
 16. insert admin_credentials            — normalized email; unique index on lower(email) backstops
 17. insert system_authority_assignments — SYSTEM_ADMIN, granted_by_user_id = null,
                                             source reason "First administrator created by installation
                                             bootstrap"; validate_system_admin_candidate trigger still applies
 18. insert instance_bootstrap           — singleton=1 primary key (structurally at most one row)
 19. insert audit_logs                   — FIRST_ADMIN_BOOTSTRAPPED, actor_type=SYSTEM, source=
                                             'first_admin_bootstrap', after_state contains
                                             user_id/assignment_id/authority_code/division_code/role_code/
                                             credential_algorithm/telegram_identity_present — no email,
                                             no password, no hash
 20. COMMIT                              — steps 11-19 are one plpgsql transaction: all-or-nothing
  |
  v
CLI prints FIRST_ADMIN_CREATED user_id=<n> email=<addr>, authority/division/role, and a
second-administrator recommendation; password buffer zeroed in a finally block; exit 0.

Failure mapping (repository): named tokens + 23505-on-instance_bootstrap_pkey -> FIRST_ADMIN_ALREADY_EXISTS
(exit 3); 23505-on-admin_credentials_email_uidx -> EMAIL_ALREADY_REGISTERED (exit 4);
PGRST202/PGRST205/42883/42P01 -> INCOMPATIBLE_SCHEMA (exit 6); everything else ->
BOOTSTRAP_TRANSACTION_FAILED (exit 1). No stack traces; single sanitized `CODE: message` line on stderr.
```

The reconstruction matches ADR P0-11 with one intentional deviation noted in F-005 (`verifyPassword` is exported now rather than deferred to P1-01 — unused, unwired, and harmless).

## Findings

### F-001 — Remote migration registry state reconciled after the incident

Severity: Resolved (read-only operational reconciliation; not a code defect)
Affected location: linked remote Supabase project migration registry; `scripts/migrate.ts` / `npm run migrate`
Explanation: During Codex validation, npm resolved the real Supabase CLI and applied `202609080001_create_notification_event_intake.sql` and `202609090001_create_first_admin_bootstrap.sql` to the currently linked remote project. A subsequent read-only reconciliation confirmed that the remote migration registry recorded both versions and that the complete 14-version remote history aligns with the repository inventory.
Evidence: Supabase CLI 2.116.0 describes `migration list --linked` as a list-only operation. Running that command reported matching local and remote entries for both `202609080001` and `202609090001`. A separate count-only PostgREST `HEAD` query reported `ADMIN_CREDENTIAL_COUNT = 0`. The previously established read-only result remains `BOOTSTRAP_COMPLETED = NO`.
Recommended direction: Preserve the reconciled state. `202609080001` and `202609090001` remain immutable applied identities; any future correction must be a NEW forward migration.

### F-002 — Bootstrap fail-closed on the remote instance depends on the historical-authority guard

Severity: Info (confirmation of a safety property, not a defect)
Affected location: `supabase/migrations/202609090001_create_first_admin_bootstrap.sql:75-79`
Explanation: The eligibility predicate is `exists(...) or exists(...) or exists(...)` over `instance_bootstrap`, `system_authority_assignments` (any row, active or revoked — rows are never deleted; revocation is soft), and `admin_credentials`. Because the remote instance has at least one authority assignment (`ACTIVE_SYSTEM_ADMINS = 1`), the RPC will raise `FIRST_ADMIN_ALREADY_EXISTS` there despite `BOOTSTRAP_COMPLETED = NO`. The remote instance cannot be turned into a bootstrap target by deactivating or revoking the existing administrator.
Evidence: Direct SQL inspection (this review); read-only checker output `LIVE_BOOTSTRAP_SCHEMA = PASS`, `BOOTSTRAP_COMPLETED = NO`, `ACTIVE_SYSTEM_ADMINS = 1`. Not proven by live remote invocation — deliberately, per the review constraints.
Recommended direction: None required. Document the fail-closed expectation in the incident write-up so no future operator "tests" setup against the linked remote project.

### F-003 — CLI pre-check is advisory and racy by design

Severity: Info
Affected location: `src/cli/setup.ts:171-177`; `src/repositories/first-admin-bootstrap.repository.ts:102-121`
Explanation: `getStatus()` reads `instance_bootstrap` / `system_authority_assignments` / `admin_credentials` outside any transaction and outside the advisory lock. A concurrent bootstrap between the pre-check and the RPC is possible; the RPC (not the pre-check) is authoritative and the second caller receives `FIRST_ADMIN_ALREADY_EXISTS` (or the mapped 23505). No secret is collected before the pre-check, so a raced refusal leaks nothing.
Evidence: Code inspection; this matches ADR P0-11's explicit requirement that any pre-check be message-quality only. Codex's real concurrent-bootstrap test (one succeeds, one refused) covers the authoritative path in a disposable PostgreSQL 16 environment.
Recommended direction: None.

### F-004 — `SOTOAYAM_BOOTSTRAP_ADMIN_PASSWORD` cannot be zeroed from the environment

Severity: Low
Affected location: `src/cli/setup.ts:145-147`
Explanation: When the password is supplied via the environment variable, the CLI copies it into a Buffer (which IS zeroed after hashing) but cannot scrub the parent process environment; the plaintext persists in the process environment and in whatever scope exported it (shell, systemd snippet, CI log surface) for the process lifetime. The interactive prompt — the documented default — has no such residue, and the variable is setup-time-only (commented in `.env.example`; not in the `install-env.sh` REQUIRED list).
Evidence: Code inspection; `.env.example` diff in the working tree.
Recommended direction: Document in the install guide (P0-16) that the env-var source is for non-interactive automation only and that the variable should be set in a single command's scope (`SOTOAYAM_BOOTSTRAP_ADMIN_PASSWORD=… node dist/src/cli/setup.js`), never persisted to `shared/.env`. No code change needed for P0-12.

### F-005 — `verifyPassword` exported ahead of P1-01

Severity: Info
Affected location: `src/auth/admin-password.ts:68-90`
Explanation: The ADR allowed deferring `verifyPassword` entirely to P1-01; the implementation exports it now. It is unused by any route or runtime path (confirmed by inspection: no imports outside tests), implements constant-time comparison via `timingSafeEqual`, and parses the self-describing encoding so P1-01 can verify existing rows without re-migration. There is no attack surface: it is library code not reachable from HTTP.
Evidence: Code inspection; Antigravity typecheck/build/secrets passes; no route changes exist in the working tree.
Recommended direction: Accept as-is; P1-01 consumes it directly.

### F-006 — Raw-mode password prompt handles bytes, not keystrokes

Severity: Low
Affected location: `src/cli/setup.ts:69-105`
Explanation: The no-echo prompt processes input byte-by-byte: Enter (13/10), Ctrl+C (3), and backspace (8/127) are handled; Delete, arrow keys, and terminal paste bracketing are not. Consequences are cosmetic: multi-byte UTF-8 passwords are preserved byte-for-byte (correct for hashing), but editing beyond backspace can leave surprising sequences in the buffer. The confirmation prompt catches any operator error, and the policy rejects control characters (`\p{Cc}`), so a mangled control sequence cannot become a weak-but-accepted password silently.
Evidence: Code inspection.
Recommended direction: Acceptable for an interactive one-time installer; if revisited, prefer a small hardened prompt library or extend the byte filter — do not change the hashing/format contract.

No High or Critical findings. No finding requires changes to the migration, the RPC, or the eligibility model.

## Adversarial Cases

Legend: PASS / FAIL / NOT VERIFIED. "Codex DB" = disposable PostgreSQL 16 environment applying all 14 migrations in order. "Inspection" = this review's direct source/SQL inspection.

| Case | Result | Basis |
| --- | --- | --- |
| A. Fresh bootstrap | PASS | Codex DB: fresh bootstrap succeeded; exactly one active normalized user, IT/ADMIN/SYSTEM_ADMIN state, no OWNER, no Telegram dependency. Inspection: RPC writes steps 15-19 atomically. |
| B. Second bootstrap | PASS | Codex DB: second bootstrap rejected. Inspection: G1 (`instance_bootstrap` exists) alone forces `FIRST_ADMIN_ALREADY_EXISTS`; CLI pre-check refuses before password collection. |
| C. Deactivation cannot re-arm | PASS | Codex DB: verified. Inspection: G1 is satisfied permanently by the singleton marker independent of authority state; eligibility never tests for an *active* admin. |
| D. Authority revocation cannot re-arm | PASS | Codex DB: verified. Same basis as C. |
| E. Historical authority state blocks bootstrap | PASS | Codex DB: a database with only revoked assignments (no marker) is refused. Inspection: G2 tests `exists(...)` over ALL rows in `system_authority_assignments`, active or revoked. Also applies to the remote instance (see F-002). |
| F. Existing credential blocks bootstrap | PASS | Codex DB: verified. Inspection: G3 tests `exists(admin_credentials)`; unique email index is the independent backstop. |
| G. Concurrent bootstrap | PASS | Codex DB: real concurrent bootstrap test — exactly one committed, the other refused; plus the lock-removed variant (Case H). Antigravity environment: NOT VERIFIED (DB tests skipped); concurrency reasoning confirmed by inspection. |
| H. Lock-independent protection | PASS | Codex DB: with the advisory lock removed, the `instance_bootstrap` singleton primary key still blocks a second commit (23505, mapped to `FIRST_ADMIN_ALREADY_EXISTS`). Inspection: `singleton smallint primary key check (singleton = 1)`. |
| I. Transaction rollback | PASS | Codex DB: taxonomy failure and late audit failure both roll back the entire transaction. Inspection: steps 11-19 are one plpgsql body; no partial administrator is reachable. |
| J. Missing IT division | PASS | Codex DB: taxonomy failure rolls back. Inspection: `TAXONOMY_UNAVAILABLE` (P0002, exit 7) raised before any insert. |
| K. Missing ADMIN role | PASS | Codex DB: same taxonomy guard covers both lookups (division and role checked together). Inspection: `202609090001:84-89`. |
| L. No Telegram dependency | PASS | Codex DB: bootstrap succeeds with `legacy_telegram_user_id = null`, no `user_channels` row, no Telegram token. Inspection: RPC inserts null legacy id; `loadSupabaseConfig()` is used, not `loadConfig()`. |
| M. SYSTEM_ADMIN only / no OWNER | PASS | Codex DB: correct IT/ADMIN/SYSTEM_ADMIN state, no OWNER. Inspection: RPC grants only `SYSTEM_ADMIN` authority + IT/`ADMIN` business taxonomy; `roles.code='OWNER'` is never selected. |
| N. Password policy | PASS | Inspection: length 12-256, whitespace-only and control-char rejection, email-local-part/display-name containment rejection (case-folded), ~300-entry common-password deny list, enforced before hashing so plaintext never reaches the network on rejection. Codex unit tests cover the policy. |
| O. Password storage | PASS | Inspection: scrypt N=32768/r=8/p=1, 16-byte CSPRNG salt, 32-byte key, self-describing encoding `scrypt$N=..,r=..,p=..$salt$key`; only `password_algorithm` + `password_hash` are sent to the RPC; DB check constraint enforces `password_algorithm in ('scrypt')` and hash length 40-512. Codex DB: normalized email and credential state verified. |
| P. CLI secret handling | PASS | Inspection: no `--password` flag exists (unknown args rejected); no-echo prompt; confirmation; buffers zeroed; success output prints user_id + email only — never password, hash, salt, or keys; error path prints one sanitized token line. Codex tests cover no-plaintext-in-output assertions. |
| Q. CLI pre-check race | PASS | Inspection + design: pre-check is advisory-only; the RPC is authoritative under the advisory lock (see F-003). Codex DB: concurrent test proves the authoritative path. |
| R. SECURITY DEFINER | PASS | Inspection: `security definer` with `set search_path = ''`, fully schema-qualified references, `revoke all ... from public, anon, authenticated`, `grant execute ... to service_role`. Codex DB: anon/authenticated cannot execute; service_role can. |
| S. RLS | PASS | Inspection: both new tables `enable row level security` with zero policies (deny-all), matching every existing table. Codex DB: RLS enabled, no policies, table access denied to non-service roles. |
| T. Audit safety | PASS | Codex DB: audit mutation rejected (append-only trigger holds); audit row exists iff administrator exists (same transaction). Inspection: `after_state` contains no email, password, hash, or secret-shaped key; `source = 'first_admin_bootstrap'` does not misattribute to the HTTP admin path. |
| U. HTTP auth compatibility | PASS | Inspection: no route, session, cookie, or `admin-authorization.ts` change exists in the working tree; `ADMIN_API_KEY` centralized fail-closed authorization is untouched. |
| V. Packaged production runtime | PASS | Antigravity: `dist/src/cli/setup.js` exists; build passes. Inspection: `"setup": "node dist/src/cli/setup.js"` — plain Node, no `tsx`; `tsx` is devDependencies-only and pruned by `deploy-release.sh`. |
| W. Exit code contract | PASS | Inspection: exit codes match the ADR error contract (0 success; 2 input/validation; 3 already-exists; 4 email collision; 5 missing configuration; 6 incompatible schema; 7 taxonomy unavailable; 1 transaction failure). Codex tests cover the mapping. |
| X. Historical migration integrity | PASS | Antigravity + this review: `git diff --check` clean; no historical migration modified; `202609090001` is a new file; the only touched migrations list contains no renamed or edited history. |

No case is FAIL. Antigravity-only environment did not re-execute the DB-backed cases (G, H, I, and the live parts of A-L); those rests are on Codex disposable-PostgreSQL evidence plus static inspection, and are marked as such above.

## Remote Incident Reconciliation

Context: during Codex validation, `npm run migrate` accidentally resolved the real local Supabase CLI, which applied `202609080001_create_notification_event_intake.sql` and `202609090001_create_first_admin_bootstrap.sql` to the currently linked remote project. No bootstrap RPC was invoked, no administrator was created, no credential was intentionally created, no VPS was touched, no rollback was attempted. The remote checker script is confirmed read-only by inspection: it contains zero `insert/update/delete/upsert/rpc` calls (grep count: 0) — it performs SELECT-style inspection only.

| Case | Result | Basis |
| --- | --- | --- |
| Y. Remote migration registry state | PASS | Read-only `supabase migration list --linked` reported both `202609080001` and `202609090001` in the remote registry, with matching local versions. |
| Z. Remote schema presence | PASS | Read-only remote checker: `LIVE_BOOTSTRAP_SCHEMA = PASS` — the P0-12 schema objects exist remotely. |
| AA. Bootstrap data state | PASS (negative) | `BOOTSTRAP_COMPLETED = NO` and the count-only query returned `ADMIN_CREDENTIAL_COUNT = 0`. No bootstrap marker or administrator credential was created by the incident. |
| AB. Authority state | PASS | `ACTIVE_SYSTEM_ADMINS = 1` — the remote instance has its pre-existing administrator(s). No identities printed. This directly implies the fail-closed property below. |
| AC. Forward-schema compatibility | PASS | The applied migrations are the exact files present in the repository (no historical migration modified; `202609090001` is additive and forward-only). The remote schema is therefore the intended v-next shape; no compatibility gap is introduced by the incident itself. |
| AD. Migration registry consistency | PASS | The remote list contains the same 14 version identifiers as the repository inventory, including matching entries for `202609080001` and `202609090001`; no missing or remote-only version was reported. |
| AE. Incident severity | Low-to-Medium (operational) | Schema-only, additive, non-destructive, RLS-preserving, idempotent-friendly. The security posture is unchanged: no RPC was called, the credential count is zero, bootstrap is fail-closed remotely (F-002), and registry consistency is now confirmed. Remaining severity comes from the original process failure (npm shadowing), not from unresolved remote state. |
| AF. Required remediation | Completed for remote reconciliation | Preserve `202609080001` and `202609090001` as immutable applied identities. Separately harden the tooling path so a future test cannot resolve the real Supabase CLI unintentionally. Do not run `npm run setup` against the linked remote project; it would correctly refuse. |

**Fail-closed interpretation (verified from the actual RPC SQL, not assumed):** `bootstrap_first_admin` raises `FIRST_ADMIN_ALREADY_EXISTS` when `exists (select 1 from public.system_authority_assignments)` — this predicate has no `revoked_at is null` filter, so it matches ANY historical row. Since the remote instance has at least one authority assignment (`ACTIVE_SYSTEM_ADMINS = 1`), `npm run setup` against the linked remote project will fail closed with exit 3, even though `BOOTSTRAP_COMPLETED = NO`. Bootstrap cannot re-arm remotely. This was NOT proven by invoking the RPC remotely — and must not be.

## Database / Concurrency Assessment

**Can two first admins commit?** No. Three independent barriers: (1) the `gwens_system_admin_invariant` advisory xact lock serializes bootstrap against itself and all other authority mutations; the second transaction evaluates eligibility only after the first commits and refuses; (2) `instance_bootstrap.singleton` is a `smallint primary key check (singleton = 1)` — the table physically holds at most one row, so even with the lock removed the second insert blocks on the uncommitted key and fails 23505; (3) the unique index on `lower(email)` in `admin_credentials`. Evidence tier: Codex disposable PostgreSQL 16 (real concurrent test, including the lock-removed variant). Antigravity environment: reasoning verified by inspection; live concurrency NOT VERIFIED locally (DB tests skipped).

**Can bootstrap re-arm?** No. Eligibility never tests for an *active* administrator. G1 (`instance_bootstrap`) is permanent once written; G2 matches any historical `system_authority_assignments` row (revocation is soft; rows are never deleted, enforced by `protect_final_system_admin`'s DELETE guard). Deactivating or revoking the sole admin does not re-open bootstrap. Evidence tier: Codex disposable PostgreSQL (explicit deactivation and revocation tests); remote instance fail-closed established by SQL inspection against the read-only checker's `ACTIVE_SYSTEM_ADMINS = 1`.

**Is bootstrap state atomic?** Yes. The entire creation — identity, credential, authority, marker, audit — is one plpgsql transaction. Forced-failure tests (taxonomy missing, late audit failure) showed full rollback in the Codex disposable environment. No partial-administrator intermediate state is reachable.

**Is DB state authoritative?** Yes. No environment variable, flag, file, or build constant participates in eligibility; the CLI pre-check is advisory and non-authoritative (F-003). The database is the sole source of "has this instance been provisioned".

**Does concurrency protection survive application races?** Yes. A racy or malicious application-level pre-check cannot create a second admin, because the deciding check runs inside the RPC under the advisory lock, with the structural primary key as a lock-independent backstop. The pre-check race only affects message quality, never state.

## Password Security Assessment

- **Length policy:** 12–256 characters, enforced in `validatePasswordPolicy` before hashing and before any network I/O; the RPC independently re-checks credential material shape (algorithm + hash length 40–512).
- **Weak/common rejection:** whitespace-only and Unicode control-character rejection; case-folded rejection if the password contains the email local part or the display name; a bundled ~300-entry common-password deny list (bases × common numeric suffixes) checked as an exact set match. No composition rules — consistent with NIST SP 800-63B as the ADR intended. Interactive confirmation prompt guards operator typos.
- **Scrypt parameters:** N = 32768 (2^15), r = 8, p = 1, key length 32 bytes — approximately 100 ms/class memory-hard cost, adequate for an installer-created administrator credential, with `maxmem` raised to 64 MiB to clear Node's default ceiling. Parameters are embedded in the stored encoding, so cost can be raised later without schema change.
- **Salt:** 16 bytes from `crypto.randomBytes` (CSPRNG), unique per hash, stored alongside the derived key and zeroed from memory after encoding.
- **Stored format:** `scrypt$N=32768,r=8,p=1$<salt base64>$<derived key base64>` — self-describing; DB check constrains `password_algorithm in ('scrypt')` and hash length 40–512.
- **Verification:** `verifyPassword` exists (exported, currently unused — F-005), parses the encoding, re-derives with the embedded parameters, and compares via `crypto.timingSafeEqual`. P1-01 can consume it with no re-migration of stored values.
- **Plaintext handling:** never accepted as argv (unknown flags are rejected outright); sources are `--password-file` (trimmed of a terminal newline), the setup-time-only env var, or a no-echo raw-mode prompt with confirmation; the plaintext Buffer is zeroed in `finally` blocks on both success and failure paths; hashing happens entirely in Node — the RPC receives only the algorithm name and the encoded hash.
- **Logs/errors:** success output prints `user_id` and the (operator-supplied) email, authority/division/role, and a second-admin recommendation — never the password, hash, or salt. Failure output is a single `CODE: message` line with no stack trace. The audit row's `after_state` contains `credential_algorithm` only — no email, password, hash, or salt-shaped key. `npm run check:secrets` passes (Antigravity evidence).

## SQL Privilege / RLS Assessment

- **SECURITY DEFINER:** `bootstrap_first_admin` is `security definer`, following the established convention (`register_telegram_identity`, `assign_system_admin`, `intake_notification_event`). The definer surface is bounded: single-purpose, input-revalidating, and revoked from every non-service role.
- **search_path:** pinned with `set search_path = ''`; all references inside the function body are fully schema-qualified (`public.*`), so a hijacked search_path cannot redirect resolution.
- **Schema qualification:** verified by direct SQL inspection — every table, the lock expression, and the trigger semantics are referenced through `public.`.
- **Grants/revokes:** `revoke all on function ... from public, anon, authenticated` then `grant execute ... to service_role`. Codex disposable-PostgreSQL checks confirmed anon/authenticated cannot execute the RPC and service_role can.
- **RLS:** both new tables (`admin_credentials`, `instance_bootstrap`) have `enable row level security` with **no policies** — deny-all for anon/authenticated, service_role bypasses by role, matching the established 23-table posture. Codex checks confirmed RLS enabled with no policies and denied non-service access.
- **Triggers remain authoritative:** bootstrap inserts into `system_authority_assignments` directly, so `validate_system_admin_candidate` (active user in IT) still fires on the insert — the invariant is database-enforced, not caller-trusted. Audit append-only (`prevent_audit_log_mutation`) was confirmed live by Codex (mutation rejected).

## HTTP Auth Compatibility Assessment

Confirmed by working-tree inspection: **`ADMIN_API_KEY` remains the HTTP admin authentication mechanism.** No login, session, cookie, token-issuance, or password-verification code is wired into any route. `src/auth/admin-authorization.ts` and the centralized fail-closed plugin are unchanged; all 11 admin route groups still authenticate the shared key via `AdminPrincipal { kind: "shared-api-key" }`. The bootstrapped credential row is dormant until P1-01 implements signed HTTP-only sessions against `admin_credentials`. P0-12 must not be described to customers as "admin login is ready."

## Packaging Assessment

Confirmed: `dist/src/cli/setup.js` exists (Antigravity build pass + this review's file check). The production script is `"setup": "node dist/src/cli/setup.js"` — plain Node with no `tsx` and no dev-only runtime dependency; `tsx` is in devDependencies and is removed on the VPS by `npm prune --omit=dev` in `deploy-release.sh`. A `"setup:dev": "tsx src/cli/setup.ts"` alias exists for local work only and is not the production path. No new runtime npm dependency was added (scrypt/salt/zeroing all from `node:crypto`); the common-password deny list ships as source. `npm run check:first-admin-bootstrap` is a dev-time checker (`tsx scripts/...`) and is correctly absent from the packaged runtime path.

## Test Quality Assessment

### Codex disposable PostgreSQL validation

Codex applied all 14 migrations in order to a disposable PostgreSQL 16 cluster and verified: fresh bootstrap; normalized email; correct IT/ADMIN/SYSTEM_ADMIN state; no OWNER; no Telegram dependency; second-bootstrap rejection; deactivation cannot re-arm; authority revocation cannot re-arm; historical (revoked-only) authority blocks bootstrap; existing credential blocks bootstrap; taxonomy failures roll back; late audit failure rolls back; real concurrent bootstrap; lock-removed concurrency safety; RLS enabled with no policies; anon/authenticated cannot execute the RPC; service_role can; audit mutation rejected. Totals reported by Codex: 33 bootstrap unit/CLI/schema tests, 8 real PostgreSQL tests, **572 tests passed including the 8 DB tests**. Packaging and production-only install verified; no historical migration modified; no VPS touched.

### Antigravity current environment

Independently executed and passed: `npm run typecheck`; `npm run build`; `npm run check:secrets`; `npm test` — **565 passed, 8 DB tests skipped** (this environment has no disposable PostgreSQL wired into the test runner); `npm run test:contract`; `git diff --check`. `dist/src/cli/setup.js` confirmed present; no historical migration modified.

The totals are different and must stay different: 572 = 565-equivalent suite + 8 DB tests that only run against a live disposable PostgreSQL. **No skipped test is presented as passed anywhere in this report.** The DB-backed behavioral claims in this review (concurrency, rollback, RLS/privilege, re-arm refusal) rest on Codex's disposable-cluster evidence, corroborated by this review's static SQL and source inspection — not on the Antigravity test run.

## Residual Risks

### Accepted / Deferred

- **IT/ADMIN compatibility bridge:** the RPC depends on the literal catalog codes `IT` and `ADMIN`, seeded by migration `202608290001`. Single-point, parameterless, fails cleanly with `TAXONOMY_UNAVAILABLE`; removed by P0-13/P0-14 (taxonomy-as-data). Accepted by ADR.
- **Bootstrap admin access-edit limitation:** the Telegram-less administrator (`legacy_telegram_user_id = null`) cannot be edited through `update_user_access` until P0-13/P0-14 relax the legacy-mapping requirement. Their division/role/active state is fixed at creation. Documented; must appear in the P0-16 install guide.
- **No login/session yet:** credential storage only; `ADMIN_API_KEY` remains the HTTP mechanism until P1-01. Sequencing risk: between install and P1-01, admin access = shared key possession.
- **Admin recovery deferred:** bootstrap is deliberately not a recovery path and cannot re-arm. v1.0 posture: create a second administrator immediately after installation (the CLI already prints this recommendation); the customer's `shared/.env` + Supabase credentials remain the break-glass. Formal recovery/reset belongs to P1-01.
- **Remote migration identity now immutable:** `202609080001` and `202609090001` are applied remotely; they can never be renamed, rewritten, deleted, or re-timestamped. Any future correction is a NEW forward migration.
- **Single-administrator window:** between first bootstrap and the second administrator, host loss or a forgotten password has no in-product recovery. Mitigated by the CLI's printed recommendation and schema continuity guards.
- **Env-var password residue** (F-004): the `SOTOAYAM_BOOTSTRAP_ADMIN_PASSWORD` source leaves plaintext in the process environment; interactive prompt is the recommended default.

### Blocking

None. No finding in this review blocks P0-12 acceptance. The remote migration registry reconciliation in F-001 is complete and found no drift.

## Validation

### Codex evidence

- `npm run setup` implemented with CLI → service → repository → RPC layering; `admin_credentials`, `instance_bootstrap`, `bootstrap_first_admin` added in `202609090001`.
- 33 bootstrap unit/CLI/schema tests + 8 real PostgreSQL tests; **572 total tests passed** in a disposable PostgreSQL 16 environment with all 14 migrations applied in order.
- Packaging verified (`dist/src/cli/setup.js`, production-only install, no `tsx` at runtime); no historical migration modified; no VPS touched.

### Antigravity evidence

- `npm run typecheck` PASS; `npm run build` PASS; `npm run check:secrets` PASS; `npm test` **565 passed, 8 DB tests skipped**; `npm run test:contract` PASS; `git diff --check` PASS; `dist/src/cli/setup.js` EXISTS; no historical migration modified.
- Read-only remote checker (`scripts/check-first-admin-bootstrap.ts`, confirmed write-free by inspection): `LIVE_BOOTSTRAP_SCHEMA = PASS`, `BOOTSTRAP_COMPLETED = NO`, `ACTIVE_SYSTEM_ADMINS = 1`.
- Read-only remote reconciliation: `supabase migration list --linked` reported matching local/remote entries for all 14 versions, including `202609080001` and `202609090001`; a count-only PostgREST `HEAD` query returned `ADMIN_CREDENTIAL_COUNT = 0`.
- This review's own inspection: migration SQL, `src/cli/setup.ts`, `src/services/first-admin-bootstrap.service.ts`, `src/repositories/first-admin-bootstrap.repository.ts`, `src/auth/admin-password.ts`, `package.json` wiring, and the absence of any route/session/`admin-authorization.ts` change.
- NOT executed by any reviewer in this cycle: live remote RPC invocation (prohibited) and the 8 DB tests in the Antigravity environment.

## Gate Decision

P0-12 MAY PROCEED

## Remote Migration Gate

REMOTE MIGRATION STATE RECONCILED — SAFE TO PRESERVE

Basis: the applied remote schema is confirmed good; both applied versions are present in the remote registry and align with their repository versions; `BOOTSTRAP_COMPLETED = NO`; `ADMIN_CREDENTIAL_COUNT = 0`; and the unfiltered historical-authority guard remains fail-closed with the known authority state. Preserve the current forward schema. Do NOT rename, rewrite, delete, or re-timestamp `202609080001` or `202609090001`; any future correction must be a new forward migration.
