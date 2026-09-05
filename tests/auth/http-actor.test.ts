import { describe, expect, it, vi } from "vitest";
import type { Permission, SystemAuthorityAssignment } from "../../src/governance/types.js";
import type { PermissionsRepository } from "../../src/repositories/permissions.repository.js";
import type { SystemAuthorityRepository } from "../../src/repositories/system-authority.repository.js";
import type { TaskUsersRepository } from "../../src/repositories/task-users.repository.js";
import { AuthenticatedOwnerActorService, AuthenticatedTaskActorService, SupabaseHumanSessionVerifier } from "../../src/services/task-actor.service.js";
import { SystemAuthorityService } from "../../src/services/system-authority.service.js";
import type { TaskUser } from "../../src/tasks/types.js";

const users = new Map<number, TaskUser>([
  [1, { id: 1, displayName: "Admin A", active: true, divisionId: 10, divisionCode: "IT", roleId: 2, roleCode: "ADMIN" }],
  [2, { id: 2, displayName: "Admin B", active: true, divisionId: 10, divisionCode: "IT", roleId: 2, roleCode: "ADMIN" }],
  [3, { id: 3, displayName: "Owner A", active: true, divisionId: 20, divisionCode: "MANAGEMENT", roleId: 3, roleCode: "OWNER" }],
  [4, { id: 4, displayName: "Owner B", active: true, divisionId: 20, divisionCode: "MANAGEMENT", roleId: 3, roleCode: "OWNER" }],
  [5, { id: 5, displayName: "Disabled", active: false, divisionId: 10, divisionCode: "IT", roleId: 2, roleCode: "ADMIN" }],
]);

const taskUsers: TaskUsersRepository = {
  findById: async (id) => users.get(id) ?? null,
};

const permission = (code: string): Permission => ({ id: 1, code, name: code, active: true, created_at: "now", updated_at: "now" });
const permissions: PermissionsRepository = {
  findAll: async () => [],
  findForRoleCode: async (role) => role === "OWNER" ? [permission("report.view_cross_division")] : [permission("task.view_division")],
};

const assignment = (userId: number): SystemAuthorityAssignment => ({
  id: userId, user_id: userId, authority_code: "SYSTEM_ADMIN", granted_at: "now", granted_by_user_id: null,
  revoked_at: null, revoked_by_user_id: null, reason: null, created_at: "now", updated_at: "now",
});
const authorities: SystemAuthorityRepository = {
  findActiveForUser: async (id) => id <= 2 ? assignment(id) : null,
  countActive: async () => 2,
  assign: vi.fn(),
  revoke: vi.fn(),
};

const sessions = { verify: async (token: string) => Number(token.replace("user-", "")) };

describe("authenticated HTTP actor resolution", () => {
  it("requires a well-formed Bearer session", async () => {
    const resolver = new AuthenticatedTaskActorService(sessions, taskUsers, permissions);
    await expect(resolver.resolveTrustedActor()).rejects.toMatchObject({ statusCode: 401, code: "AUTHENTICATION_REQUIRED" });
    await expect(resolver.resolveTrustedActor("Basic abc")).rejects.toMatchObject({ statusCode: 401, code: "AUTHENTICATION_REQUIRED" });
  });

  it("attributes two administrators to their own verified identities", async () => {
    const resolver = new AuthenticatedTaskActorService(sessions, taskUsers, permissions, authorities);
    await expect(resolver.resolveTrustedActor("Bearer user-1")).resolves.toMatchObject({ id: 1, displayName: "Admin A" });
    await expect(resolver.resolveTrustedActor("Bearer user-2")).resolves.toMatchObject({ id: 2, displayName: "Admin B" });
  });

  it("allows multiple owners while preserving the caller identity", async () => {
    const resolver = new AuthenticatedOwnerActorService(new AuthenticatedTaskActorService(sessions, taskUsers, permissions));
    await expect(resolver.resolveOwnerActor("Bearer user-3")).resolves.toMatchObject({ id: 3, roleCode: "OWNER" });
    await expect(resolver.resolveOwnerActor("Bearer user-4")).resolves.toMatchObject({ id: 4, roleCode: "OWNER" });
    await expect(resolver.resolveOwnerActor("Bearer user-1")).rejects.toMatchObject({ statusCode: 403, code: "OWNER_AUTHORITY_REQUIRED" });
  });

  it("denies disabled users and callers without active system authority", async () => {
    const ordinary = new AuthenticatedTaskActorService(sessions, taskUsers, permissions);
    const admin = new AuthenticatedTaskActorService(sessions, taskUsers, permissions, authorities);
    await expect(ordinary.resolveTrustedActor("Bearer user-5")).rejects.toMatchObject({ code: "AUTHENTICATED_USER_INACTIVE" });
    await expect(admin.resolveTrustedActor("Bearer user-3")).rejects.toMatchObject({ code: "SYSTEM_AUTHORITY_REQUIRED" });
  });

  it("verifies Supabase sessions and reads only server-controlled app metadata", async () => {
    const getUser = vi.fn().mockResolvedValue({ data: { user: { app_metadata: { gwens_user_id: 2 } } }, error: null });
    const verifier = new SupabaseHumanSessionVerifier({ auth: { getUser } } as never);
    await expect(verifier.verify("access-token")).resolves.toBe(2);
    expect(getUser).toHaveBeenCalledWith("access-token");
  });

  it("rejects invalid sessions and missing identity mappings", async () => {
    const invalid = new SupabaseHumanSessionVerifier({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: new Error("invalid") }) } } as never);
    const unmapped = new SupabaseHumanSessionVerifier({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { app_metadata: {}, user_metadata: { gwens_user_id: 1 } } }, error: null }) } } as never);
    await expect(invalid.verify("bad")).rejects.toMatchObject({ statusCode: 401, code: "AUTHENTICATION_INVALID" });
    await expect(unmapped.verify("token")).rejects.toMatchObject({ statusCode: 403, code: "AUTHENTICATED_USER_UNMAPPED" });
  });

  it("attributes system-authority mutations to the authenticated caller", async () => {
    const repository = { ...authorities, assign: vi.fn().mockResolvedValue(assignment(2)), revoke: vi.fn().mockResolvedValue(assignment(2)) };
    const service = new SystemAuthorityService({ countSystemAdminCandidates: vi.fn() } as never, repository);
    await service.assign(2, "handover", 1);
    await service.revoke(2, "revoke", 1);
    expect(repository.assign).toHaveBeenCalledWith(2, "handover", 1);
    expect(repository.revoke).toHaveBeenCalledWith(2, "revoke", 1);
  });
});
