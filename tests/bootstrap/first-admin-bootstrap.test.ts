import { readFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { hashPassword, validatePasswordPolicy, verifyPassword } from "../../src/auth/admin-password.js";
import { runSetup, type SetupDependencies, type SetupIo } from "../../src/cli/setup.js";
import {
  FirstAdminBootstrapError,
  SupabaseFirstAdminBootstrapRepository,
  type FirstAdminBootstrapInput,
  type FirstAdminBootstrapRepository,
  type FirstAdminBootstrapStatus,
} from "../../src/repositories/first-admin-bootstrap.repository.js";
import { FirstAdminBootstrapService, normalizeFirstAdminIdentity } from "../../src/services/first-admin-bootstrap.service.js";
import { reconcileIdentitySnapshots } from "../../src/services/identity-reconciliation.service.js";

const migrationPath = path.resolve(
  process.cwd(),
  "supabase/migrations/202609090001_create_first_admin_bootstrap.sql",
);

class BootstrapRepository implements FirstAdminBootstrapRepository {
  status: FirstAdminBootstrapStatus = { eligible: true };
  input?: FirstAdminBootstrapInput;
  failure?: Error;

  async getStatus() { return this.status; }
  async bootstrap(input: FirstAdminBootstrapInput) {
    this.input = input;
    if (this.failure) throw this.failure;
    return { userId: 41, assignmentId: 73, bootstrappedAt: new Date(0).toISOString() };
  }
  async preview(lineage: "FRESH" | "LEGACY") {
    return { lineage, eligible: this.status.eligible, evidence: {
      users: 0, telegram_users: 0, tasks: 0, non_migration_seed_audit_logs: 0,
      extra_or_modified_seed_divisions: 0, non_origin_collaboration_rules: 0,
      users_division_refs: 0, task_requesting_division_refs: 0, task_owner_division_refs: 0,
      collaboration_source_division_refs: 1, collaboration_target_division_refs: 1,
      integration_requesting_division_refs: 0, routing_owner_division_refs: 0, alert_owner_division_refs: 0,
    }, retirement_divisions: Array.from({ length: 9 }, (_, id) => ({ code: `SEED_${id}`, name: `Seed ${id}` })),
    retirement_rule: { task_scope: "ALL" } };
  }
  async resolveActiveDivision(code: string) { return code === "IT" ? { code, name: "IT" } : null; }
  async provision(input: FirstAdminBootstrapInput & { lineage: "FRESH" | "LEGACY"; divisionCode: string }) {
    this.input = input;
    if (this.failure) throw this.failure;
    return { userId: 41, assignmentId: 73, bootstrappedAt: new Date(0).toISOString(), divisionCode: input.divisionCode };
  }
}

function streamText(stream: PassThrough): () => string {
  let content = "";
  stream.on("data", (chunk) => { content += chunk.toString(); });
  return () => content;
}

function cliHarness(repository = new BootstrapRepository(), env: NodeJS.ProcessEnv = {}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const output = streamText(stdout);
  const errors = streamText(stderr);
  const io = {
    stdin: Object.assign(Readable.from([]), { isTTY: false }), stdout, stderr, env,
  } as unknown as SetupIo;
  const dependencies: SetupDependencies = {
    createService: () => new FirstAdminBootstrapService(repository),
    promptText: vi.fn().mockRejectedValue(new Error("unexpected prompt")),
    promptSecret: vi.fn().mockRejectedValue(new FirstAdminBootstrapError(
      "BOOTSTRAP_INPUT_UNAVAILABLE", "A password source is required when stdin is not interactive",
    )),
    readPasswordFile: vi.fn().mockResolvedValue(Buffer.from("file-password-strong-8842\n")),
  };
  return { repository, io, dependencies, output, errors };
}

describe("first-administrator password security", () => {
  it("uses the approved versioned scrypt parameters and verifies the result", async () => {
    const encoded = await hashPassword("correct horse battery staple");
    expect(encoded).toMatch(/^scrypt\$N=32768,r=8,p=1\$[^$]+\$[^$]+$/);
    expect(encoded).not.toContain("correct horse battery staple");
    await expect(verifyPassword("correct horse battery staple", encoded)).resolves.toBe(true);
    await expect(verifyPassword("incorrect horse battery staple", encoded)).resolves.toBe(false);
  });

  it.each([
    "too-short",
    " ".repeat(12),
    "password123456",
    "operator@example-safe-value",
    "Ada Lovelace has a secure value",
    `valid-prefix-${String.fromCharCode(7)}-control`,
    "x".repeat(257),
  ])("rejects weak password %# without calling the database", async (password) => {
    const repository = new BootstrapRepository();
    const service = new FirstAdminBootstrapService(repository);
    await expect(service.bootstrap({ displayName: "Ada Lovelace", email: "operator@example.com", password }))
      .rejects.toMatchObject({ code: "WEAK_PASSWORD", exitCode: 2 });
    expect(repository.input).toBeUndefined();
  });

  it("accepts a long non-common passphrase unrelated to identity", () => {
    expect(() => validatePasswordPolicy("orchid-river-canvas-ember-91", {
      displayName: "Ada Lovelace", email: "operator@example.com",
    })).not.toThrow();
  });
});

describe("first-administrator input and service contract", () => {
  it("normalizes identity and sends only the derived hash to the repository", async () => {
    const repository = new BootstrapRepository();
    const service = new FirstAdminBootstrapService(repository);
    const result = await service.bootstrap({
      displayName: "  Ada Lovelace  ", email: " Admin@Example.COM ", password: "orchid-river-canvas-ember-91",
    });
    expect(result).toMatchObject({
      userId: 41, displayName: "Ada Lovelace", email: "admin@example.com",
      authority: "SYSTEM_ADMIN", division: "IT", role: "ADMIN",
    });
    expect(repository.input).toMatchObject({
      displayName: "Ada Lovelace", email: "admin@example.com", passwordAlgorithm: "scrypt",
    });
    expect(repository.input).not.toHaveProperty("password");
    expect(repository.input?.passwordHash).not.toContain("orchid-river-canvas-ember-91");
  });

  it.each([
    ["", "admin@example.com", "INVALID_DISPLAY_NAME"],
    ["x".repeat(121), "admin@example.com", "INVALID_DISPLAY_NAME"],
    ["Admin", "not-an-email", "INVALID_EMAIL"],
    ["Admin", "admin@example", "INVALID_EMAIL"],
  ])("rejects invalid identity without hashing or database access", (name, email, code) => {
    expect(() => normalizeFirstAdminIdentity(name, email)).toThrow(expect.objectContaining({ code }));
  });

  it("keeps a Telegram-less bootstrap identity outside legacy reconciliation", () => {
    expect(reconcileIdentitySnapshots([], [{
      id: 41, legacy_telegram_user_id: null, active: true, division_code: "IT", role_code: "ADMIN",
    }], [])).toEqual({ match: 0, missingNormalized: 0, missingLegacy: 0, mismatch: 0, duplicate: 0 });
  });
});

describe("first-administrator repository contract", () => {
  it("calls the distinct seven-argument provisioning RPC with hashed credentials only", async () => {
    const single = vi.fn().mockResolvedValue({ data: {
      user_id: 41, assignment_id: 73, bootstrapped_at: new Date(0).toISOString(), division_code: "OPERATIONS",
    }, error: null });
    const rpc = vi.fn().mockReturnValue({ single });
    const repository = new SupabaseFirstAdminBootstrapRepository({ rpc } as unknown as SupabaseClient);
    await expect(repository.provision({ displayName: "Installer", email: "installer@example.com",
      passwordAlgorithm: "scrypt", passwordHash: "encoded-value", lineage: "FRESH",
      divisionCode: "OPERATIONS", divisionName: "Operations" })).resolves.toMatchObject({ divisionCode: "OPERATIONS" });
    expect(rpc).toHaveBeenCalledWith("provision_first_installation", expect.objectContaining({
      p_lineage: "FRESH", p_division_code: "OPERATIONS", p_division_name: "Operations",
      p_password_hash: "encoded-value",
    }));
    expect(rpc.mock.calls[0]?.[1]).not.toHaveProperty("p_password");
  });

  it("calls the single atomic RPC with no plaintext password field", async () => {
    const single = vi.fn().mockResolvedValue({
      data: { user_id: 41, assignment_id: 73, bootstrapped_at: new Date(0).toISOString() }, error: null,
    });
    const rpc = vi.fn().mockReturnValue({ single });
    const repository = new SupabaseFirstAdminBootstrapRepository({ rpc } as unknown as SupabaseClient);
    await expect(repository.bootstrap({
      displayName: "Installer", email: "installer@example.com", passwordAlgorithm: "scrypt", passwordHash: "encoded-value",
    })).resolves.toMatchObject({ userId: 41, assignmentId: 73 });
    expect(rpc).toHaveBeenCalledWith("bootstrap_first_admin", {
      p_display_name: "Installer",
      p_email: "installer@example.com",
      p_password_algorithm: "scrypt",
      p_password_hash: "encoded-value",
    });
    expect(rpc.mock.calls[0]?.[1]).not.toHaveProperty("p_password");
  });

  it.each([
    [{ code: "P0001", message: "FIRST_ADMIN_ALREADY_EXISTS" }, "FIRST_ADMIN_ALREADY_EXISTS", 3],
    [{ code: "23505", message: "duplicate key admin_credentials_email_uidx" }, "EMAIL_ALREADY_REGISTERED", 4],
    [{ code: "PGRST202", message: "function unavailable" }, "INCOMPATIBLE_SCHEMA", 6],
    [{ code: "P0002", message: "TAXONOMY_UNAVAILABLE" }, "TAXONOMY_UNAVAILABLE", 7],
    [{ code: "22023", message: "INVALID_CREDENTIAL_MATERIAL" }, "INVALID_CREDENTIAL_MATERIAL", 2],
    [{ code: "08006", message: "connection failure" }, "BOOTSTRAP_TRANSACTION_FAILED", 1],
  ])("maps database diagnostic %# to a stable CLI error", async (diagnostic, code, exitCode) => {
    const client = { rpc: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: null, error: diagnostic }) }) };
    const repository = new SupabaseFirstAdminBootstrapRepository(client as unknown as SupabaseClient);
    await expect(repository.bootstrap({
      displayName: "Installer", email: "installer@example.com", passwordAlgorithm: "scrypt", passwordHash: "encoded-value",
    })).rejects.toMatchObject({ code, exitCode });
  });
});

describe("setup CLI contract", () => {
  it("requires one explicit lineage flag outside an interactive terminal", async () => {
    const harness = cliHarness();
    const exit = await runSetup(["--name", "Installer", "--email", "installer@example.com"], harness.io, harness.dependencies);
    expect(exit).toBe(2);
    expect(harness.errors()).toContain("INVALID_INSTALLATION_LINEAGE");
    expect(harness.dependencies.promptSecret).not.toHaveBeenCalled();
  });

  it("rejects mutually exclusive lineage flags", async () => {
    const harness = cliHarness();
    const exit = await runSetup(["--fresh-install", "--keep-existing-taxonomy"], harness.io, harness.dependencies);
    expect(exit).toBe(2);
    expect(harness.errors()).toContain("mutually exclusive");
  });

  it("resolves an existing active division before collecting a legacy-mode password", async () => {
    const harness = cliHarness(undefined, { SOTOAYAM_BOOTSTRAP_ADMIN_PASSWORD: "environment-password-strong-99" });
    const resolve = vi.spyOn(harness.repository, "resolveActiveDivision");
    const exit = await runSetup(["--keep-existing-taxonomy", "--division-code", "IT",
      "--name", "Installer", "--email", "installer@example.com"], harness.io, harness.dependencies);
    expect(exit).toBe(0);
    expect(resolve).toHaveBeenCalledWith("IT");
    expect(harness.repository.input).toMatchObject({ lineage: "LEGACY", divisionCode: "IT" });
  });

  it("fails a missing legacy division and fresh evidence veto before password collection", async () => {
    const missing = cliHarness();
    const missingExit = await runSetup(["--keep-existing-taxonomy", "--division-code", "MISSING",
      "--name", "Installer", "--email", "installer@example.com"], missing.io, missing.dependencies);
    expect(missingExit).toBe(7);
    expect(missing.dependencies.promptSecret).not.toHaveBeenCalled();

    const veto = cliHarness();
    const preview = await veto.repository.preview("FRESH");
    vi.spyOn(veto.repository, "preview").mockResolvedValue({ ...preview, evidence: { ...preview.evidence, users: 1 } });
    const vetoExit = await runSetup(["--fresh-install", "--division-name", "Operations", "--division-code", "OPERATIONS",
      "--name", "Installer", "--email", "installer@example.com"], veto.io, veto.dependencies);
    expect(vetoExit).toBe(8);
    expect(veto.errors()).toContain("FRESH_INSTALL_EVIDENCE_VETO");
    expect(veto.dependencies.promptSecret).not.toHaveBeenCalled();
  });

  it("uses password-file before environment and never prints secret material", async () => {
    const harness = cliHarness(undefined, { SOTOAYAM_BOOTSTRAP_ADMIN_PASSWORD: "environment-password-strong-99" });
    const exit = await runSetup([
      "--fresh-install", "--division-name", "Operations", "--division-code", "OPERATIONS",
      "--name", "Installer", "--email", "installer@example.com", "--password-file", "protected.txt",
    ], harness.io, harness.dependencies);
    expect(exit).toBe(0);
    expect(harness.dependencies.readPasswordFile).toHaveBeenCalledWith("protected.txt");
    expect(await verifyPassword("file-password-strong-8842", harness.repository.input!.passwordHash)).toBe(true);
    expect(await verifyPassword("environment-password-strong-99", harness.repository.input!.passwordHash)).toBe(false);
    expect(harness.output()).toContain("FIRST_ADMIN_CREATED user_id=41 email=installer@example.com");
    expect(harness.output() + harness.errors()).not.toMatch(/file-password|environment-password|scrypt\$/);
  });

  it("uses the environment before the interactive secret prompt", async () => {
    const harness = cliHarness(undefined, { SOTOAYAM_BOOTSTRAP_ADMIN_PASSWORD: "environment-password-strong-99" });
    const exit = await runSetup(["--fresh-install", "--division-name", "Operations", "--division-code", "OPERATIONS", "--name", "Installer", "--email", "installer@example.com"], harness.io, harness.dependencies);
    expect(exit).toBe(0);
    expect(harness.dependencies.promptSecret).not.toHaveBeenCalled();
    expect(await verifyPassword("environment-password-strong-99", harness.repository.input!.passwordHash)).toBe(true);
  });

  it("rejects argv password input", async () => {
    const harness = cliHarness();
    const exit = await runSetup([
      "--name", "Installer", "--email", "installer@example.com", "--password", "never-allowed",
    ], harness.io, harness.dependencies);
    expect(exit).toBe(2);
    expect(harness.errors()).toContain("BOOTSTRAP_INPUT_UNAVAILABLE");
    expect(harness.repository.input).toBeUndefined();
  });

  it("rejects duplicate setup flags", async () => {
    const harness = cliHarness();
    const exit = await runSetup([
      "--name", "Installer", "--name", "Other", "--email", "installer@example.com",
    ], harness.io, harness.dependencies);
    expect(exit).toBe(2);
    expect(harness.errors()).toContain("Duplicate setup argument: --name");
    expect(harness.repository.input).toBeUndefined();
  });

  it("refuses an existing installation before collecting a password", async () => {
    const harness = cliHarness();
    harness.repository.status = { eligible: false, existingUserId: 41, completedAt: new Date(0).toISOString() };
    const exit = await runSetup(["--fresh-install", "--division-name", "Operations", "--division-code", "OPERATIONS", "--name", "Installer", "--email", "installer@example.com"], harness.io, harness.dependencies);
    expect(exit).toBe(3);
    expect(harness.dependencies.promptSecret).not.toHaveBeenCalled();
    expect(harness.dependencies.readPasswordFile).not.toHaveBeenCalled();
    expect(harness.errors()).toContain("FIRST_ADMIN_ALREADY_EXISTS");
    expect(harness.output()).toContain("SETUP_PREVIEW");
  });

  it("fails closed without a password source on non-TTY stdin", async () => {
    const harness = cliHarness();
    const exit = await runSetup(["--fresh-install", "--division-name", "Operations", "--division-code", "OPERATIONS", "--name", "Installer", "--email", "installer@example.com"], harness.io, harness.dependencies);
    expect(exit).toBe(2);
    expect(harness.errors()).toContain("BOOTSTRAP_INPUT_UNAVAILABLE");
    expect(harness.repository.input).toBeUndefined();
  });

  it("returns stable mapped transaction failures without a stack or secret", async () => {
    const harness = cliHarness(undefined, { SOTOAYAM_BOOTSTRAP_ADMIN_PASSWORD: "environment-password-strong-99" });
    harness.repository.failure = new FirstAdminBootstrapError("TAXONOMY_UNAVAILABLE", "Required administrative taxonomy is unavailable");
    const exit = await runSetup(["--fresh-install", "--division-name", "Operations", "--division-code", "OPERATIONS", "--name", "Installer", "--email", "installer@example.com"], harness.io, harness.dependencies);
    expect(exit).toBe(7);
    expect(harness.errors()).toBe("TAXONOMY_UNAVAILABLE: Required administrative taxonomy is unavailable\n");
    expect(harness.errors()).not.toContain("environment-password-strong-99");
  });
});

describe("first-administrator migration contract", () => {
  it("creates service-only deny-all schema with an atomic audit", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).toContain("create table public.admin_credentials");
    expect(sql).toContain("create table public.instance_bootstrap");
    expect(sql).toContain("singleton smallint primary key default 1 check (singleton = 1)");
    expect(sql).toContain("create unique index admin_credentials_email_uidx");
    expect(sql.match(/enable row level security/g)).toHaveLength(2);
    expect(sql).not.toMatch(/create\s+policy/i);
    expect(sql).toContain("security definer\nset search_path = ''");
    expect(sql).toContain("from public, anon, authenticated");
    expect(sql).toContain("to service_role");
    expect(sql).toContain("'FIRST_ADMIN_BOOTSTRAPPED'");
  });

  it("enforces all three eligibility guards under the established authority lock", async () => {
    const sql = await readFile(migrationPath, "utf8");
    const lock = sql.indexOf("pg_advisory_xact_lock(hashtextextended('gwens_system_admin_invariant', 0))");
    expect(lock).toBeGreaterThan(0);
    for (const table of ["instance_bootstrap", "system_authority_assignments", "admin_credentials"]) {
      expect(sql.indexOf(`exists (select 1 from public.${table})`)).toBeGreaterThan(lock);
    }
  });

  it("accepts no plaintext password and creates SYSTEM_ADMIN without OWNER or Telegram", async () => {
    const sql = await readFile(migrationPath, "utf8");
    const signature = sql.match(/bootstrap_first_admin\(([\s\S]*?)\)\nreturns table/)?.[1] ?? "";
    expect(signature).toContain("p_password_algorithm text");
    expect(signature).toContain("p_password_hash text");
    expect(signature).not.toMatch(/p_password\s+text/);
    expect(sql).toContain("'SYSTEM_ADMIN'");
    expect(sql).not.toContain("'OWNER'");
    expect(sql).toContain("legacy_telegram_user_id)\n  values (trim(p_display_name), administrative_division_id, administrative_role_id, true, null)");
  });

  it("is an additive migration that leaves existing authority and taxonomy objects unchanged", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).not.toMatch(/\b(?:drop\s+table|truncate|delete\s+from)\b/i);
    expect(sql).not.toMatch(/alter\s+table\s+public\.(?:users|divisions|roles|system_authority_assignments)/i);
    expect(sql).not.toMatch(/insert\s+into\s+public\.(?:divisions|roles)\b/i);
    expect(sql).not.toMatch(/create\s+or\s+replace\s+function\s+public\.(?:assign_system_admin|update_user_access|validate_system_admin_candidate)/i);
  });
});
