import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { resolveAdminPrincipal } from "../../src/auth/admin-authorization.js";
import { validatePasswordPolicy, verifyPassword } from "../../src/auth/admin-password.js";
import { AppError } from "../../src/errors.js";
import { adminUserManagementRoutes } from "../../src/routes/admin-user-management.routes.js";
import { UserManagementService, toAdminUserDto } from "../../src/services/user-management.service.js";
import type { ManagedUser } from "../../src/user-management/types.js";

const migrationPath = path.resolve("supabase/migrations/202609140001_create_admin_user_management.sql");
const historicalPath = path.resolve("supabase/migrations/202609130001_harden_effective_system_admin_invariant.sql");
const historicalHash = "3b7113fb091685cf3dfe070b99917ae485be197369508943b8fc96c426c0498f";

const managed = (overrides: Partial<ManagedUser> = {}): ManagedUser => ({
  id: 10, display_name: "Admin Uji", email: "admin@example.test", business_user_code: null,
  division: { id: 1, code: "OPERATIONS", name: "Operations", active: true, grants_system_authority: true,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  role: { id: 2, code: "ADMIN", name: "Admin", active: true, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  active: true, telegram_connected: false, has_login: true, password_change_required: false,
  system_admin: true, effective_system_admin: true, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  ...overrides,
});

const principal = { kind: "session" as const, adminUserId: 10, sessionId: "u-session", email: "admin@example.test",
  displayName: "Admin Uji", expiresAt: "2099-01-01T00:00:00Z" };
const sessionAuthenticator = (authenticated = true) => ({ authenticate: vi.fn(async () => authenticated ? principal : null), verifyCsrf: vi.fn(() => true) });
const actor = (effective = true) => ({ resolveTrustedActor: vi.fn(), resolveActor: vi.fn(async () => ({ id: 10, displayName: "Admin Uji",
  active: true, divisionId: 1, divisionCode: "OPERATIONS", divisionGrantsSystemAuthority: effective,
  roleId: 2, roleCode: "ADMIN", permissions: new Set<string>() })) });

function routeService() {
  const value = managed();
  return {
    catalogs: vi.fn(async () => ({ divisions: [value.division], roles: [value.role] })),
    authoritySummary: vi.fn(async () => ({ effective_system_admins: 2, you_are_last: false })),
    listPage: vi.fn(async () => ({ data: [toAdminUserDto(value, 10)], nextCursor: null })),
    get: vi.fn(async () => value), getDto: vi.fn(async () => toAdminUserDto(value, 10)),
    createAdministrator: vi.fn(async () => ({ user: toAdminUserDto(value, 10), temporaryPassword: "temporary-password" })),
    updateProfile: vi.fn(async () => value), updateAccess: vi.fn(async () => value),
    grantLogin: vi.fn(async () => ({ user: toAdminUserDto(value, 10), temporaryPassword: "temporary-password" })),
    grantSystemAdmin: vi.fn(async () => toAdminUserDto(value, 10)), revokeSystemAdmin: vi.fn(async () => toAdminUserDto(value, 10)),
    updateBusinessUserCode: vi.fn(async () => value),
  };
}

const endpointCases = [
  ["GET", "/api/admin/users/catalogs"], ["GET", "/api/admin/users/authority-summary"], ["GET", "/api/admin/users"],
  ["GET", "/api/admin/users/10"], ["POST", "/api/admin/users", { display_name: "Admin", email: "a@example.test", division_id: 1, role_id: 2, grant_system_admin: false, reason: "test" }],
  ["PATCH", "/api/admin/users/10/profile", { display_name: "Admin Baru" }],
  ["PATCH", "/api/admin/users/10/access", { active: true }], ["POST", "/api/admin/users/10/login", { email: "b@example.test", reason: "test" }],
  ["POST", "/api/admin/users/10/system-admin", { reason: "test" }], ["DELETE", "/api/admin/users/10/system-admin", { reason: "test", confirm: true }],
  ["PATCH", "/api/admin/users/10/business-user-code", { business_user_code: "OPS-10", confirm_change: false }],
] as const;

describe("P2-09 Admin & User Management acceptance", () => {
  it("U-01 permits an effective SYSTEM_ADMIN session on every endpoint and applies CSRF", async () => {
    const auth = sessionAuthenticator(); const app = Fastify();
    await app.register(adminUserManagementRoutes, { prefix: "/api/admin/users", service: routeService() as never,
      sessionAuthenticator: auth, actorResolver: actor(), adminApiKey: "shared-key" });
    for (const [method, url, payload] of endpointCases) {
      const response = await app.inject({ method, url, ...(payload ? { payload } : {}) });
      expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(200);
    }
    expect(auth.verifyCsrf).toHaveBeenCalledTimes(endpointCases.filter(([method]) => method !== "GET").length);
    await app.close();
  });

  it("U-02 rejects a session actor without effective SYSTEM_ADMIN capability", async () => {
    const app = Fastify(); await app.register(adminUserManagementRoutes, { prefix: "/api/admin/users", service: routeService() as never,
      sessionAuthenticator: sessionAuthenticator(), actorResolver: actor(false) });
    expect((await app.inject({ method: "GET", url: "/api/admin/users" })).statusCode).toBe(403); await app.close();
  });

  it("U-03 rejects the shared ADMIN_API_KEY on every P2-09 endpoint", async () => {
    const app = Fastify(); await app.register(adminUserManagementRoutes, { prefix: "/api/admin/users", service: routeService() as never,
      sessionAuthenticator: sessionAuthenticator(false), actorResolver: actor(), adminApiKey: "shared-key" });
    for (const [method, url, payload] of endpointCases) {
      const response = await app.inject({ method, url, headers: { "x-admin-api-key": "shared-key" }, ...(payload ? { payload } : {}) });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
    await app.close();
  });

  it("U-04 rejects a demoted session before an authority mutation", async () => {
    const service = routeService(); const resolver = actor(); resolver.resolveActor.mockRejectedValue(new AppError(403, "ADMIN_AUTHORITY_REQUIRED", "demoted"));
    const app = Fastify(); await app.register(adminUserManagementRoutes, { prefix: "/api/admin/users", service: service as never,
      sessionAuthenticator: sessionAuthenticator(), actorResolver: resolver });
    expect((await app.inject({ method: "POST", url: "/api/admin/users/10/system-admin", payload: { reason: "restore" } })).statusCode).toBe(403);
    expect(service.grantSystemAdmin).not.toHaveBeenCalled(); await app.close();
  });

  it("U-05 maps only the exact safe DTO fields", () => {
    expect(Object.keys(toAdminUserDto(managed() as ManagedUser & { password_hash?: string }, 10)).sort()).toEqual([
      "active", "business_user_code", "created_at", "display_name", "division", "effective_system_admin", "email", "has_login",
      "id", "is_current_user", "password_change_required", "role", "system_admin", "telegram_connected", "updated_at",
    ]);
    expect(JSON.stringify(toAdminUserDto({ ...managed(), password_hash: "forbidden" } as never, 10))).not.toContain("forbidden");
  });

  it("U-06 composes filters in the bounded repository RPC and rejects invalid values", async () => {
    const service = routeService(); const app = Fastify(); await app.register(adminUserManagementRoutes, { prefix: "/api/admin/users",
      service: service as never, sessionAuthenticator: sessionAuthenticator(), actorResolver: actor() });
    expect((await app.inject({ url: "/api/admin/users?q=admin&status=active&division_id=1&system_admin=true&has_login=false&limit=50" })).statusCode).toBe(200);
    expect(service.listPage).toHaveBeenCalledWith(expect.objectContaining({ q: "admin", status: "active", division_id: 1,
      system_admin: true, has_login: false, limit: 50 }), 10);
    expect((await app.inject({ url: "/api/admin/users?system_admin=yes" })).statusCode).toBe(400); await app.close();
  });

  it("U-07 uses versioned keyset cursors and rejects malformed cursors", async () => {
    const repo = { findAll: vi.fn(async () => [managed({ id: 3, created_at: "2026-03-01T00:00:00Z" }), managed({ id: 2, created_at: "2026-02-01T00:00:00Z" })]) };
    const service = new UserManagementService(repo as never, {} as never, {} as never);
    const first = await service.listPage({ limit: 1 }, 10); const second = await service.listPage({ limit: 1, cursor: first.nextCursor! }, 10);
    expect(first.data[0]?.id).toBe(3); expect(second.data[0]?.id).toBe(2); expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    await expect(service.listPage({ limit: 1, cursor: "not-json" }, 10)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("U-08 normalizes credential emails before the atomic repository call", async () => {
    const createAdministrator = vi.fn(async () => managed({ email: "mixed@example.test" }));
    const service = new UserManagementService({ createAdministrator } as never, {} as never, {} as never);
    await service.createAdministrator({ displayName: " Mixed ", email: " MIXED@Example.Test ", divisionId: 1, roleId: 2,
      grantSystemAdmin: false, reason: " account " }, 10);
    expect(createAdministrator).toHaveBeenCalledWith(expect.objectContaining({ displayName: "Mixed", email: "mixed@example.test" }));
  });

  it("keeps a static migration guard for the U-09 create RPC shape", async () => {
    const sql = await readFile(migrationPath, "utf8"); const block = sql.split("create function public.create_administrator_account")[1]!.split("create function public.grant_admin_login")[0]!;
    expect(block).toContain("insert into public.users"); expect(block).toContain("insert into public.admin_credentials");
    expect(block).toContain("assign_system_admin"); expect(block).toContain("ADMIN_USER_CREATED");
  });

  it("U-10 returns a policy-valid password once and passes only its scrypt hash to persistence", async () => {
    let persisted = null as null | { passwordHash: string };
    const service = new UserManagementService({ createAdministrator: vi.fn(async (input) => { persisted = input; return managed(); }) } as never, {} as never, {} as never);
    const result = await service.createAdministrator({ displayName: "Admin Baru", email: "baru@example.test", divisionId: 1, roleId: 2,
      grantSystemAdmin: false, reason: "testing" }, 10);
    expect(() => validatePasswordPolicy(result.temporaryPassword, { email: "baru@example.test", displayName: "Admin Baru" })).not.toThrow();
    expect(persisted?.passwordHash).not.toBe(result.temporaryPassword); expect(await verifyPassword(result.temporaryPassword, persisted!.passwordHash)).toBe(true);
  });

  it("keeps a static migration guard against Telegram identity creation in the U-11 RPC", async () => {
    const sql = await readFile(migrationPath, "utf8"); const block = sql.split("create function public.grant_admin_login")[1]!.split("create function public.update_admin_user_profile")[0]!;
    expect(block).toContain("insert into public.admin_credentials"); expect(block).not.toMatch(/insert into public\.(telegram_users|user_channels)/);
  });

  it("U-12 restricts temporary-password sessions while retaining auth route handling", async () => {
    await expect(resolveAdminPrincipal({ headers: {} } as never, { sessionAuthenticator: { authenticate: async () => ({ ...principal,
      passwordChangeRequired: true }), verifyCsrf: () => true } })).rejects.toMatchObject({ statusCode: 403, code: "PASSWORD_CHANGE_REQUIRED" });
    const authRoutes = await readFile(path.resolve("src/routes/admin-auth.routes.ts"), "utf8");
    expect(authRoutes).toContain('app.get("/session"'); expect(authRoutes).toContain('app.post("/password"'); expect(authRoutes).toContain('app.post("/logout"');
  });

  it("keeps a static migration guard for U-13 audit declarations", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).toContain("USER_PROFILE_UPDATED"); expect(sql).toContain("p_actor_user_id"); expect(sql).toContain("admin_user_management_api");
  });

  it("U-14 rejects self-deactivation before persistence", async () => {
    const updateAccess = vi.fn(); const service = new UserManagementService({ findById: async () => managed(), updateAccess } as never,
      { findAll: async () => [managed().division] } as never, { findAll: async () => [managed().role] } as never);
    await expect(service.updateAccess(10, { division_id: 1, role_id: 2, active: false }, "api", 10)).rejects.toMatchObject({ code: "SELF_DEACTIVATION_FORBIDDEN" });
    expect(updateAccess).not.toHaveBeenCalled();
  });

  it("U-15 requires confirmed, reasoned self-demotion and delegates the locked last-admin decision", async () => {
    const updateAccess = vi.fn(async () => managed({ effective_system_admin: false }));
    const service = new UserManagementService({ findById: async () => managed(), updateAccess } as never,
      { findAll: async () => [{ ...managed().division, id: 2, active: true, grants_system_authority: false }] } as never,
      { findAll: async () => [managed().role] } as never);
    await expect(service.updateAccess(10, { division_id: 2, role_id: 2, active: true }, "api", 10)).rejects.toMatchObject({ code: "SELF_DEMOTION_CONFIRMATION_REQUIRED" });
    await service.updateAccess(10, { division_id: 2, role_id: 2, active: true }, "api", 10, { confirm: true, reason: "handover complete" });
    expect(updateAccess).toHaveBeenCalledWith(10, expect.anything(), "api", 10, expect.objectContaining({ confirm: true }));
  });

  it("keeps the compatibility advisory-lock spelling as a static U-16 guard", async () => {
    const sql = await readFile(migrationPath, "utf8"); expect(sql).toContain("gwens_system_admin_invariant");
    expect(sql).toContain("public.is_effective_system_admin");
  });

  it("keeps a static migration guard for the U-17 session-revocation statement", async () => {
    const sql = await readFile(migrationPath, "utf8"); const block = sql.split("create function public._apply_managed_user_access")[1]!.split("create function public.update_managed_user_access")[0]!;
    expect(block).toMatch(/update public\.admin_sessions[\s\S]*revoked_at = now\(\)/); expect(block).toContain("ADMIN_SESSION_REVOKED");
  });

  it("U-18 provides the modular local-asset Pengguna UI without browser secret storage", async () => {
    const [html, js, css] = await Promise.all([readFile(path.resolve("public/index.html"), "utf8"), readFile(path.resolve("public/users.js"), "utf8"), readFile(path.resolve("public/styles.css"), "utf8")]);
    for (const marker of ["users-filter", "users-more", "user-detail", "create-user-dialog", "temporary-password-dialog"]) expect(html).toContain(marker);
    for (const flow of ["/profile", "/access", "/login", "/system-admin", "authority-summary"]) expect(js).toContain(flow);
    expect(js).not.toMatch(/localStorage|sessionStorage|ADMIN_API_KEY|password_hash/); expect(css).toContain("@media (max-width: 575.98px)"); expect(html).not.toMatch(/https?:\/\//);
  });

  it("U-19 preserves P2-09 through subsequent additive migrations", async () => {
    const names = (await readdir(path.resolve("supabase/migrations"))).filter((name) => name.endsWith(".sql")).sort();
    expect(names).toHaveLength(25); expect(names).toContain("202609140001_create_admin_user_management.sql");
    expect(createHash("sha256").update(await readFile(historicalPath)).digest("hex")).toBe(historicalHash);
  });
});
