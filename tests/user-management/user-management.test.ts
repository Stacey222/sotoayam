import { readFile } from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../src/errors.js";
import type { Division, Role } from "../../src/governance/types.js";
import { adminUserManagementRoutes } from "../../src/routes/admin-user-management.routes.js";
import { UserManagementService } from "../../src/services/user-management.service.js";
import type { AccessUpdate, ManagedUser, UserManagementStatus } from "../../src/user-management/types.js";

const migrationPath = path.resolve(process.cwd(), "supabase/migrations/202608290003_create_it_user_management.sql");
const governancePath = path.resolve(process.cwd(), "supabase/migrations/202608290001_create_governance_foundation.sql");
const identityPath = path.resolve(process.cwd(), "supabase/migrations/202608290002_create_normalized_identity.sql");

const division = (id: number, code: string, active = true): Division => ({ id, code, name: code, active, created_at: "now", updated_at: "now" });
const role = (id: number, code: string, active = true): Role => ({ id, code, name: code, active, created_at: "now", updated_at: "now" });
const divisions = [division(1, "IT"), division(2, "SALES_GROSIR"), division(3, "DISABLED", false)];
const roles = [role(1, "STAFF"), role(2, "ADMIN"), role(3, "DISABLED", false)];
const user = (overrides: Partial<ManagedUser> = {}): ManagedUser => ({
  id: 1, display_name: "Safe User", division: null, role: null, active: false,
  telegram_connected: true, created_at: "now", updated_at: "now", ...overrides,
});

class MemoryUsers {
  values: ManagedUser[] = [];
  updates: Array<{ id: number; update: AccessUpdate; source: string }> = [];
  async findAll(status?: UserManagementStatus) {
    return this.values.filter((item) => !status || (status === "active" ? item.active : status === "pending" ? !item.active && (!item.division || !item.role) : !item.active && !!item.division && !!item.role));
  }
  async findById(id: number) { return this.values.find((item) => item.id === id) ?? null; }
  async findNormalizedByLegacyId(id: number) { return this.findById(id); }
  async updateAccess(id: number, update: AccessUpdate, source: string) {
    const value = await this.findById(id); if (!value) throw new AppError(404, "NOT_FOUND", "missing");
    value.division = divisions.find((item) => item.id === update.division_id) ?? null;
    value.role = roles.find((item) => item.id === update.role_id) ?? null;
    value.active = update.active; this.updates.push({ id, update, source }); return value;
  }
}

const divisionRepo = {
  findAll: vi.fn(async () => divisions), findByCode: vi.fn(async (code: string) => divisions.find((item) => item.code === code) ?? null), create: vi.fn(),
};
const roleRepo = {
  findAll: vi.fn(async () => roles), findByCode: vi.fn(async (code: string) => roles.find((item) => item.code === code) ?? null),
};

describe("Slice 2.5 user management acceptance", () => {
  let users: MemoryUsers;
  let service: UserManagementService;
  beforeEach(() => { users = new MemoryUsers(); service = new UserManagementService(users, divisionRepo, roleRepo); vi.clearAllMocks(); });

  it("1. lists pending users", async () => { users.values = [user(), user({ id: 2, active: true, division: divisions[0]!, role: roles[0]! })]; expect(await service.list("pending")).toHaveLength(1); });
  it("2. lists active users", async () => { users.values = [user(), user({ id: 2, active: true, division: divisions[0]!, role: roles[0]! })]; expect((await service.list("active"))[0]?.id).toBe(2); });
  it("3. lists inactive assigned users", async () => { users.values = [user({ division: divisions[0], role: roles[0] })]; expect(await service.list("inactive")).toHaveLength(1); });
  it("4. assigns a valid division", async () => { users.values = [user()]; await service.updateAccess(1, { division_id: 1, role_id: null, active: false }); expect(users.values[0]?.division?.code).toBe("IT"); });
  it("5. rejects an invalid division", async () => { users.values = [user()]; await expect(service.updateAccess(1, { division_id: 999, role_id: null, active: false })).rejects.toMatchObject({ statusCode: 400 }); });
  it("6. rejects a disabled division for a new assignment", async () => { users.values = [user()]; await expect(service.updateAccess(1, { division_id: 3, role_id: null, active: false })).rejects.toThrow("Disabled division"); });
  it("7. assigns a valid role", async () => { users.values = [user()]; await service.updateAccess(1, { division_id: null, role_id: 1, active: false }); expect(users.values[0]?.role?.code).toBe("STAFF"); });
  it("8. rejects an invalid role", async () => { users.values = [user()]; await expect(service.updateAccess(1, { division_id: null, role_id: 999, active: false })).rejects.toMatchObject({ statusCode: 400 }); });
  it("9. rejects a disabled role for a new assignment", async () => { users.values = [user()]; await expect(service.updateAccess(1, { division_id: null, role_id: 3, active: false })).rejects.toThrow("Disabled role"); });
  it("10. rejects activation without division", async () => { users.values = [user({ role: roles[0] })]; await expect(service.updateAccess(1, { division_id: null, role_id: 1, active: true })).rejects.toThrow("requires a division and role"); });
  it("11. rejects activation without role", async () => { users.values = [user({ division: divisions[0] })]; await expect(service.updateAccess(1, { division_id: 1, role_id: null, active: true })).rejects.toThrow("requires a division and role"); });
  it("12. activates with both assignments", async () => { users.values = [user()]; expect((await service.updateAccess(1, { division_id: 1, role_id: 1, active: true })).active).toBe(true); });
  it("13. stores exactly one home division", async () => { const sql = await readFile(identityPath, "utf8"); expect(sql).toContain("division_id bigint references public.divisions (id)"); expect(sql).not.toContain("user_divisions"); });
  it("14. stores exactly one business role", async () => { const sql = await readFile(identityPath, "utf8"); expect(sql).toContain("role_id bigint references public.roles (id)"); expect(sql).not.toContain("user_roles"); });
  it("15. atomically synchronizes normalized and legacy access", async () => { const sql = await readFile(migrationPath, "utf8"); const fn = sql.split("create or replace function public.update_user_access")[1] ?? ""; expect(fn).toContain("update public.users"); expect(fn).toContain("update public.telegram_users"); });
  it("16. routes legacy compatibility through the synchronized source", async () => { users.values = [user()]; await service.updateLegacyAccess(1, { division: "IT", role: "Staff", active: true }); expect(users.updates[0]?.source).toBe("legacy_admin_api_compatibility"); });
  it("17. synchronizes deactivation in the database function", async () => { const sql = await readFile(migrationPath, "utf8"); expect(sql).toMatch(/update public\.telegram_users set[\s\S]*active = p_active/); });
  it("18. audits division changes", async () => { expect(await readFile(migrationPath, "utf8")).toContain("USER_DIVISION_CHANGED"); });
  it("19. audits role changes", async () => { expect(await readFile(migrationPath, "utf8")).toContain("USER_ROLE_CHANGED"); });
  it("20. audits activation", async () => { expect(await readFile(migrationPath, "utf8")).toContain("USER_ACTIVATED"); });
  it("21. audits deactivation", async () => { expect(await readFile(migrationPath, "utf8")).toContain("USER_DEACTIVATED"); });
  it("22. guards audit writes with distinct change checks", async () => { const sql = await readFile(migrationPath, "utf8"); expect(sql.match(/is distinct from/g)?.length).toBeGreaterThanOrEqual(5); });
  it("23. does not grant user.manage to STAFF", async () => { const sql = await readFile(governancePath, "utf8"); const block = sql.split("where role_catalog.code = 'STAFF'")[0]?.split("permission_catalog.code in (").at(-1); expect(block).not.toContain("user.manage"); });
  it("24. does not infer governance from ADMIN", async () => { const sql = await readFile(governancePath, "utf8"); const block = sql.split("where role_catalog.code = 'ADMIN'")[0]?.split("permission_catalog.code in (").at(-1); expect(block).not.toContain("user.manage"); });
  it("25. does not grant user.manage to OWNER", async () => { const sql = await readFile(governancePath, "utf8"); const block = sql.split("where role_catalog.code = 'OWNER'")[0]?.split("permission_catalog.code in (").at(-1); expect(block).not.toContain("user.manage"); });
  it("26. never assigns SYSTEM_ADMIN automatically", async () => { expect(await readFile(identityPath, "utf8")).not.toMatch(/insert into public\.system_authority_assignments/i); });
  it("27. protects the final active SYSTEM_ADMIN", async () => { const sql = await readFile(migrationPath, "utf8"); expect(sql).toContain("Final active SYSTEM_ADMIN cannot be revoked without a replacement"); expect(sql).toContain("Final active SYSTEM_ADMIN must remain active in IT until handover"); });
  it("28. supports grant-then-revoke handover", async () => { const sql = await readFile(migrationPath, "utf8"); expect(sql).toContain("function public.assign_system_admin"); expect(sql).toContain("function public.revoke_system_admin"); });
  it("29. keeps reconciliation keys unchanged", async () => { const sql = await readFile(migrationPath, "utf8"); expect(sql).not.toMatch(/legacy_telegram_user_id\s*=/); expect(sql).not.toMatch(/external_id\s*=/); });
  it("30. protects normalized endpoints with the shared admin boundary", async () => {
    users.values = [user()]; const app = Fastify(); await app.register(adminUserManagementRoutes, { prefix: "/api/admin/users", service, adminApiKey: "safe-key" });
    const denied = await app.inject({ method: "GET", url: "/api/admin/users?status=pending" });
    const accepted = await app.inject({ method: "GET", url: "/api/admin/users?status=pending", headers: { "x-admin-api-key": "safe-key" } });
    expect(denied.statusCode).toBe(401); expect(accepted.statusCode).toBe(200); await app.close();
  });
});
