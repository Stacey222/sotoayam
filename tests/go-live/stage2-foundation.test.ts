import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../src/errors.js";
import type { Division, Role, SystemAuthorityAssignment } from "../../src/governance/types.js";
import { normalizeBusinessUserCode } from "../../src/identity/business-user-code.js";
import type { IntegrationAdministrationRepository, IntegrationCapability } from "../../src/repositories/integration-administration.repository.js";
import type { SystemAuthorityRepository } from "../../src/repositories/system-authority.repository.js";
import type { TaskSourceIntegration } from "../../src/repositories/task-ingestion.repository.js";
import type { TaskUsersRepository } from "../../src/repositories/task-users.repository.js";
import { IntegrationAdministrationService } from "../../src/services/integration-administration.service.js";
import { UserManagementService } from "../../src/services/user-management.service.js";
import type { BusinessUserCodeUpdate, ManagedDivision, ManagedUser } from "../../src/user-management/types.js";

const migrationPath = path.resolve(process.cwd(), "supabase/migrations/202609020001_create_business_identity_and_integration_capabilities.sql");
const now = "2026-09-02T00:00:00.000Z";
const itDivision: ManagedDivision = { id: 1, code: "IT", name: "IT", active: true, grants_system_authority: true, created_at: now, updated_at: now };
const role: Role = { id: 1, code: "ADMIN", name: "Admin", active: true, created_at: now, updated_at: now };
const managed = (overrides: Partial<ManagedUser> = {}): ManagedUser => ({ id: 1, display_name: "Operator", business_user_code: null,
  division: itDivision, role, active: true, telegram_connected: true, created_at: now, updated_at: now, ...overrides });

describe("Stage 2 business user identity", () => {
  it("normalizes safe business codes and rejects numeric identifiers", () => {
    expect(normalizeBusinessUserCode(" gw-cc-001 ")).toBe("GW-CC-001");
    expect(() => normalizeBusinessUserCode("123456")).toThrowError(expect.objectContaining({ code: "BUSINESS_USER_CODE_INVALID" }));
    expect(() => normalizeBusinessUserCode("GW CC 001")).toThrowError(expect.objectContaining({ code: "BUSINESS_USER_CODE_INVALID" }));
  });

  it("requires explicit confirmation before changing an established code", async () => {
    const value = managed({ business_user_code: "GW-IT-001" });
    const repository = { findById: async () => value, findAll: async () => [value], findNormalizedByLegacyId: async () => value,
      updateAccess: async () => value, updateBusinessUserCode: vi.fn(async (_id: number, update: BusinessUserCodeUpdate) => ({ ...value, business_user_code: update.business_user_code })) };
    const service = new UserManagementService(repository, { findAll: async () => [itDivision], findByCode: async () => itDivision, create: vi.fn() }, { findAll: async () => [role], findByCode: async () => role });
    await expect(service.updateBusinessUserCode(1, { business_user_code: "GW-IT-002", confirm_change: false }, "test", 1)).rejects.toMatchObject({ code: "BUSINESS_USER_CODE_CONFIRMATION_REQUIRED" });
    expect((await service.updateBusinessUserCode(1, { business_user_code: "gw-it-002", confirm_change: true }, "test", 1)).business_user_code).toBe("GW-IT-002");
  });

  it("uses nullable additive schema with concurrency-safe uniqueness and no backfill", async () => {
    const sql = await readFile(migrationPath, "utf8");
    const schema = sql.split("create or replace function")[0] ?? sql;
    expect(sql).toContain("add column business_user_code text");
    expect(sql).toContain("users_business_user_code_uidx");
    expect(sql).toContain("where business_user_code is not null");
    expect(schema).not.toMatch(/update\s+public\.users\s+set\s+business_user_code/i);
    expect(sql).toContain("BUSINESS_USER_CODE_ASSIGNED"); expect(sql).toContain("BUSINESS_USER_CODE_CHANGED");
  });
});

class Integrations implements IntegrationAdministrationRepository {
  values: TaskSourceIntegration[] = [];
  capabilities: IntegrationCapability[] = [];
  async list() { return this.values; }
  async findById(id: number) { return this.values.find((item) => item.id === id) ?? null; }
  async create(input: { code: string; name: string; source: "AUTOMATION" | "ERP"; requestingDivisionId: number }) { const row = { id: 1, code: input.code, name: input.name, source: input.source, requesting_division_id: input.requestingDivisionId, active: false }; this.values.push(row); return row; }
  async setActive(id: number, active: boolean) { const row = (await this.findById(id))!; row.active = active; return row; }
  async listCapabilities(id: number) { return this.capabilities.filter((item) => item.integration_id === id); }
  async grantCapability(id: number) { const existing = this.capabilities.find((item) => item.integration_id === id); if (existing) { existing.revoked_at = null; return existing; } const value: IntegrationCapability = { id: 1, integration_id: id, capability_code: "TASK_CREATE", granted_at: now, revoked_at: null, created_at: now, updated_at: now }; this.capabilities.push(value); return value; }
  async revokeCapability(id: number) { const value = this.capabilities.find((item) => item.integration_id === id && item.revoked_at === null); if (!value) throw new AppError(404, "INTEGRATION_NOT_FOUND", "missing"); value.revoked_at = now; return value; }
}

function adminHarness(options: { division?: ManagedDivision; authority?: boolean; active?: boolean } = {}) {
  const integrations = new Integrations(); integrations.values.push({ id: 1, code: "SYNC", name: "Sync", source: "AUTOMATION", requesting_division_id: 1, active: false });
  const user = managed({ division: options.division ?? itDivision, active: options.active ?? true });
  const users = { get: async () => user } as unknown as UserManagementService;
  const taskUsers = { findTrustedAdminActorUser: async () => ({ id: 1, displayName: "Operator", active: user.active, divisionId: user.division?.id ?? null, divisionCode: user.division?.code ?? null, divisionGrantsSystemAuthority: user.division?.grants_system_authority, roleId: 1, roleCode: "ADMIN" }), findById: vi.fn() } as unknown as TaskUsersRepository;
  const assignment: SystemAuthorityAssignment = { id: 1, user_id: 1, authority_code: "SYSTEM_ADMIN", granted_at: now, granted_by_user_id: null, revoked_at: null, revoked_by_user_id: null, reason: null, created_at: now, updated_at: now };
  const authorities = { findActiveForUser: async () => options.authority === false ? null : assignment, countActive: vi.fn(), assign: vi.fn(), revoke: vi.fn() } as SystemAuthorityRepository;
  const divisions = { findAll: async () => [itDivision], findByCode: async (code: string) => code === "IT" ? itDivision : null, create: vi.fn() };
  return { service: new IntegrationAdministrationService(integrations, divisions, taskUsers, users, authorities), integrations };
}

describe("Stage 2 integration capability governance", () => {
  it("allows active IT SYSTEM_ADMIN to manage only the supported capability and keeps duplicate grants idempotent", async () => { const h = adminHarness(); expect((await h.service.grantCapability(1, "TASK_CREATE")).capability_code).toBe("TASK_CREATE"); await h.service.grantCapability(1, "TASK_CREATE"); expect(h.integrations.capabilities).toHaveLength(1); await expect(h.service.grantCapability(1, "TASK_READ")).rejects.toMatchObject({ code: "INTEGRATION_CAPABILITY_UNSUPPORTED" }); });
  it("denies OWNER/business authority without SYSTEM_ADMIN", async () => { await expect(adminHarness({ authority: false }).service.list()).rejects.toMatchObject({ code: "INTEGRATION_ADMIN_FORBIDDEN" }); });
  it("denies SYSTEM_ADMIN outside an authority-capable division and inactive SYSTEM_ADMIN", async () => {
    const management = { ...itDivision, id: 2, code: "MANAGEMENT", grants_system_authority: false };
    await expect(adminHarness({ division: management }).service.list()).rejects.toMatchObject({ code: "INTEGRATION_ADMIN_FORBIDDEN" });
    await expect(adminHarness({ active: false }).service.list()).rejects.toMatchObject({ code: "INTEGRATION_ADMIN_FORBIDDEN" });
  });
  it("creates identities inactive and revokes capability immediately", async () => { const h = adminHarness(); const created = await h.service.create({ code: " future_sync ", name: "Future", source: "AUTOMATION", requestingDivisionId: 1 }); expect(created).toMatchObject({ code: "FUTURE_SYNC", active: false }); await h.service.grantCapability(1, "TASK_CREATE"); expect((await h.service.revokeCapability(1, "TASK_CREATE")).revoked_at).not.toBeNull(); });
  it("migration is default-deny, RLS protected, service-only, audited, and seeds no integration or grant", async () => {
    const sql = await readFile(migrationPath, "utf8");
    const schema = sql.split("create or replace function")[0] ?? sql;
    expect(sql).toContain("create table public.integration_capabilities"); expect(sql).toContain("capability_code = 'TASK_CREATE'");
    expect(sql).toContain("enable row level security"); expect(sql).not.toMatch(/create\s+policy/i);
    expect(sql).toContain("INTEGRATION_CAPABILITY_GRANTED"); expect(sql).toContain("INTEGRATION_CAPABILITY_REVOKED");
    expect(sql).toContain("INTEGRATION_ACTIVATED"); expect(sql).toContain("INTEGRATION_DEACTIVATED");
    expect(schema).not.toMatch(/insert\s+into\s+public\.task_source_integrations/i);
    expect(schema).not.toMatch(/insert\s+into\s+public\.integration_capabilities/i);
    for (const forbidden of ["USER_ADMIN", "ROLE_ADMIN", "SYSTEM_ADMIN", "OWNER", "COLLABORATION_RULE_ADMIN"]) expect(sql).not.toContain(`capability_code = '${forbidden}'`);
  });
});
