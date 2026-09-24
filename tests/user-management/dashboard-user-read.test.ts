import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { SupabaseUserManagementRepository } from "../../src/repositories/user-management.repository.js";
import { toAdminUserDto, UserManagementService } from "../../src/services/user-management.service.js";
import type { DivisionsRepository } from "../../src/repositories/divisions.repository.js";
import type { RolesRepository } from "../../src/repositories/roles.repository.js";

const division = { id: 2, code: "OPERATIONS", name: "Operations", active: true,
  grants_system_authority: true, provisioning_source: "SETUP", created_at: "", updated_at: "" };
const role = { id: 3, code: "ADMIN", name: "Admin", active: true, created_at: "", updated_at: "" };
const base = { display_name: null, business_user_code: null, division_id: null, role_id: null,
  active: false, legacy_telegram_user_id: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  divisions: null, roles: null, user_channels: [], admin_credentials: null, system_authority_assignments: [] };
const cases = [
  { label: "existing pending legacy user", row: { ...base, id: 1, legacy_telegram_user_id: 51 } },
  { label: "Telegram-only user", row: { ...base, id: 2, legacy_telegram_user_id: 52, active: true,
    divisions: division, roles: role, user_channels: [{ channel_type: "TELEGRAM", active: true }] } },
  { label: "login-capable user", row: { ...base, id: 3, active: true, divisions: division, roles: role,
    admin_credentials: { email: "admin@example.test", password_change_required: false, password_hash: "never-return" } } },
  { label: "SYSTEM_ADMIN user", row: { ...base, id: 4, active: true, divisions: division, roles: role,
    admin_credentials: { email: "system@example.test", password_change_required: false, password_hash: "never-return" },
    system_authority_assignments: [{ authority_code: "SYSTEM_ADMIN", revoked_at: null }] } },
];

function repositoryFor(row: unknown) {
  const select = vi.fn((_columns: string) => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }));
  const client = { from: () => ({ select }) } as unknown as SupabaseClient;
  return { repository: new SupabaseUserManagementRepository(client), select };
}

describe("dashboard Pengguna read compatibility", () => {
  it.each(cases)("loads detail for $label through the unambiguous user authority FK", async ({ row }) => {
    const { repository, select } = repositoryFor(row);
    const user = await repository.findById(row.id);
    expect(user).not.toBeNull();
    expect(select.mock.calls[0]?.[0]).toContain("system_authority_assignments!system_authority_assignments_user_id_fkey");
    const dto = toAdminUserDto(user!, 4);
    expect(dto.id).toBe(row.id);
    expect(dto.telegram_connected).toBe(row.user_channels.some((item) => item.channel_type === "TELEGRAM" && item.active));
    expect(dto.has_login).toBe(Boolean(row.admin_credentials));
    expect(dto.system_admin).toBe(row.system_authority_assignments.some((item) => item.revoked_at === null));
    expect(JSON.stringify(dto)).not.toMatch(/password_hash|legacy_telegram_user_id|telegram_chat_id|never-return/);
  });

  it("lists mixed legacy, Telegram, login, and SYSTEM_ADMIN rows through the existing page RPC", async () => {
    const rows = cases.map(({ row }) => ({ user_id: row.id, display_name: row.display_name,
      email: row.admin_credentials?.email ?? null, business_user_code: row.business_user_code,
      division_id: row.divisions?.id ?? null, division_code: row.divisions?.code ?? null,
      division_name: row.divisions?.name ?? null, division_active: row.divisions?.active ?? null,
      division_grants_system_authority: row.divisions?.grants_system_authority ?? null,
      role_id: row.roles?.id ?? null, role_code: row.roles?.code ?? null, role_name: row.roles?.name ?? null,
      role_active: row.roles?.active ?? null, user_active: row.active,
      telegram_connected: row.user_channels.some((item) => item.channel_type === "TELEGRAM" && item.active),
      has_login: Boolean(row.admin_credentials), password_change_required: false,
      system_admin: row.system_authority_assignments.some((item) => item.revoked_at === null),
      effective_system_admin: row.id === 4, created_at: row.created_at, updated_at: row.updated_at }));
    const rpc = vi.fn(async () => ({ data: rows, error: null }));
    const repository = new SupabaseUserManagementRepository({ rpc } as unknown as SupabaseClient);
    const service = new UserManagementService(repository, {} as DivisionsRepository, {} as RolesRepository);
    const page = await service.listPage({ limit: 25 }, 4);
    expect(rpc).toHaveBeenCalledWith("list_managed_admin_users", expect.objectContaining({ p_actor_user_id: 4 }));
    expect(page.data).toHaveLength(4);
    expect(page.data[0]).toMatchObject({ has_login: false, telegram_connected: false, division: null, role: null });
    expect(page.data[1]).toMatchObject({ has_login: false, telegram_connected: true });
    expect(page.data[2]).toMatchObject({ has_login: true, system_admin: false });
    expect(page.data[3]).toMatchObject({ has_login: true, system_admin: true, effective_system_admin: true, is_current_user: true });
    expect(JSON.stringify(page.data)).not.toMatch(/password_hash|legacy_telegram_user_id|telegram_chat_id|never-return/);
  });
});
