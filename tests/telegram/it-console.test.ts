import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../src/errors.js";
import type { Division, Role, SystemAuthorityAssignment } from "../../src/governance/types.js";
import type { UserChannel } from "../../src/identity/types.js";
import type { DivisionsRepository } from "../../src/repositories/divisions.repository.js";
import type { RolesRepository } from "../../src/repositories/roles.repository.js";
import type { SystemAuthorityRepository } from "../../src/repositories/system-authority.repository.js";
import type { UserChannelsRepository } from "../../src/repositories/user-channels.repository.js";
import type { UserManagementRepository } from "../../src/repositories/user-management.repository.js";
import { TelegramRegistrationService } from "../../src/services/telegram-registration.service.js";
import { UserManagementService } from "../../src/services/user-management.service.js";
import { TelegramBot } from "../../src/telegram/bot.js";
import { TelegramItConsoleService } from "../../src/telegram/it-console.js";
import type { AccessUpdate, ManagedUser, UserManagementStatus } from "../../src/user-management/types.js";

const now = "2026-08-29T00:00:00.000Z";
const divisions: Division[] = [
  { id: 10, code: "IT", name: "Information Technology", active: true, created_at: now, updated_at: now },
  { id: 20, code: "CONTENT_CREATOR", name: "Content Creator", active: true, created_at: now, updated_at: now },
];
const roles: Role[] = [
  { id: 30, code: "STAFF", name: "Staff", active: true, created_at: now, updated_at: now },
  { id: 40, code: "ADMIN", name: "Admin", active: true, created_at: now, updated_at: now },
  { id: 50, code: "OWNER", name: "Owner", active: true, created_at: now, updated_at: now },
];
const managed = (overrides: Partial<ManagedUser> = {}): ManagedUser => ({
  id: 1, display_name: "IT Operator", division: divisions[0]!, role: roles[1]!, active: true,
  telegram_connected: true, created_at: now, updated_at: now, ...overrides,
});

class MemoryUsers implements UserManagementRepository {
  values: ManagedUser[] = [
    managed(),
    managed({ id: 2, display_name: "Pending Person", division: null, role: null, active: false }),
    managed({ id: 3, display_name: "Active Person", division: divisions[1]!, role: roles[0]!, active: true }),
    managed({ id: 4, display_name: "Inactive Person", division: divisions[1]!, role: roles[0]!, active: false }),
  ];
  updates: Array<{ id: number; update: AccessUpdate; source: string; actor: number | null }> = [];
  legacy = new Map<number, { division: string; role: string; active: boolean }>();
  finalSystemAdminId = 1;

  async findAll(status?: UserManagementStatus) {
    return this.values.filter((user) => !status || (status === "active" ? user.active : status === "pending"
      ? !user.active && (!user.division || !user.role) : !user.active && Boolean(user.division && user.role)));
  }
  async findById(id: number) { return this.values.find((user) => user.id === id) ?? null; }
  async findNormalizedByLegacyId(id: number) { return this.findById(id); }
  async updateAccess(id: number, update: AccessUpdate, source: string, actor: number | null = null) {
    const index = this.values.findIndex((user) => user.id === id);
    if (index < 0) throw new AppError(404, "NOT_FOUND", "not found");
    if (id === this.finalSystemAdminId && !update.active) throw new AppError(409, "GOVERNANCE_INVARIANT", "protected");
    const current = this.values[index]!;
    const next = {
      ...current,
      division: divisions.find((item) => item.id === update.division_id) ?? null,
      role: roles.find((item) => item.id === update.role_id) ?? null,
      active: update.active,
    };
    this.values[index] = next;
    this.updates.push({ id, update, source, actor });
    this.legacy.set(id, { division: next.division?.code ?? "UNASSIGNED", role: next.role?.code ?? "UNASSIGNED", active: next.active });
    return next;
  }
}

class Catalog<T extends Division | Role> {
  constructor(public entries: T[]) {}
  async findAll(options: { activeOnly?: boolean } = {}) { return options.activeOnly ? this.entries.filter((entry) => entry.active) : this.entries; }
  async findByCode(code: string) { return this.entries.find((entry) => entry.code === code) ?? null; }
}

function harness(options: { actor?: Partial<ManagedUser>; authority?: boolean; channelActive?: boolean } = {}) {
  const repository = new MemoryUsers();
  repository.values[0] = managed(options.actor);
  const channel: UserChannel = { id: 1, user_id: 1, channel_type: "TELEGRAM", external_id: "9001", username: null,
    active: options.channelActive ?? true, verified_at: now, created_at: now, updated_at: now };
  const channels: UserChannelsRepository = { findByExternalIdentity: vi.fn().mockResolvedValue(channel) };
  const authority: SystemAuthorityAssignment = { id: 1, user_id: 1, authority_code: "SYSTEM_ADMIN", granted_at: now,
    granted_by_user_id: null, revoked_at: null, revoked_by_user_id: null, reason: "test", created_at: now, updated_at: now };
  const authorities: SystemAuthorityRepository = {
    findActiveForUser: vi.fn().mockResolvedValue(options.authority === false ? null : authority), countActive: vi.fn(),
    assign: vi.fn(), revoke: vi.fn(),
  };
  const divisionRepo = new Catalog(divisions) as unknown as DivisionsRepository;
  const roleRepo = new Catalog(roles) as RolesRepository;
  const service = new UserManagementService(repository, divisionRepo, roleRepo);
  return { console: new TelegramItConsoleService(channels, authorities, service), repository, channels, authorities,
    divisionRepo, roleRepo };
}

describe("Slice 3.1 Telegram IT console", () => {
  it("1. allows an active IT SYSTEM_ADMIN to open /admin", async () => {
    expect((await harness().console.open(9001)).text).toBe("Gwens IT Console");
  });
  it("2. denies an ordinary STAFF user", async () => {
    expect((await harness({ actor: { role: roles[0] }, authority: false }).console.open(9001)).text).toBe("Perintah tidak tersedia.");
  });
  it("3. does not authorize business ADMIN alone", async () => {
    expect((await harness({ authority: false }).console.open(9001)).text).toBe("Perintah tidak tersedia.");
  });
  it("4. does not authorize OWNER alone", async () => {
    expect((await harness({ actor: { role: roles[2] }, authority: false }).console.open(9001)).text).toBe("Perintah tidak tersedia.");
  });
  it("5. denies an inactive SYSTEM_ADMIN", async () => {
    expect((await harness({ actor: { active: false } }).console.open(9001)).text).toBe("Perintah tidak tersedia.");
  });
  it("6. lists pending users", async () => {
    const result = await harness().console.handleCallback(9001, "ac:l:p:0"); expect(result.text).toContain("Pending Person"); expect(result.text).not.toContain("Active Person");
  });
  it("7. lists active users", async () => {
    const result = await harness().console.handleCallback(9001, "ac:l:a:0"); expect(result.text).toContain("Active Person"); expect(result.text).not.toContain("Inactive Person");
  });
  it("8. lists inactive assigned users", async () => {
    const result = await harness().console.handleCallback(9001, "ac:l:i:0"); expect(result.text).toContain("Inactive Person"); expect(result.text).not.toContain("Pending Person");
  });
  it("9. loads the active division catalog dynamically", async () => {
    const test = harness(); (test.divisionRepo as unknown as Catalog<Division>).entries.push({ id: 99, code: "NEW_DIVISION", name: "New Division", active: true, created_at: now, updated_at: now });
    expect((await test.console.handleCallback(9001, "ac:x:d:2")).inlineKeyboard?.flat().map((item) => item.text)).toContain("New Division");
  });
  it("10. loads the active role catalog dynamically", async () => {
    const test = harness(); (test.roleRepo as unknown as Catalog<Role>).entries.push({ id: 99, code: "NEW_ROLE", name: "New Role", active: true, created_at: now, updated_at: now });
    expect((await test.console.handleCallback(9001, "ac:x:r:2")).inlineKeyboard?.flat().map((item) => item.text)).toContain("New Role");
  });
  it("11. assigns division only after confirm", async () => {
    const test = harness(); await test.console.handleCallback(9001, "ac:v:d:2:20"); expect(test.repository.updates).toHaveLength(0);
    await test.console.handleCallback(9001, "ac:c:d:2:20"); expect(test.repository.values[1]?.division?.code).toBe("CONTENT_CREATOR");
  });
  it("12. assigns role only after confirm", async () => {
    const test = harness(); await test.console.handleCallback(9001, "ac:c:r:2:30"); expect(test.repository.values[1]?.role?.code).toBe("STAFF");
  });
  it("13. rejects activation without division", async () => {
    expect((await harness().console.handleCallback(9001, "ac:v:a:2")).text).toContain("Tetapkan Divisi dan Role");
  });
  it("14. rejects activation without role", async () => {
    const test = harness(); test.repository.values[1] = managed({ id: 2, division: divisions[1], role: null, active: false });
    expect((await test.console.handleCallback(9001, "ac:c:a:2")).text).toContain("Tetapkan Divisi dan Role");
  });
  it("15. activates a fully assigned user", async () => {
    const test = harness(); await test.console.handleCallback(9001, "ac:c:a:4"); expect(test.repository.values[3]?.active).toBe(true);
  });
  it("16. preserves normalized and legacy compatibility parity", async () => {
    const test = harness(); await test.console.handleCallback(9001, "ac:c:a:4"); expect(test.repository.legacy.get(4)).toEqual({ division: "CONTENT_CREATOR", role: "STAFF", active: true });
  });
  it("17. sends audit source and normalized actor through the service path", async () => {
    const test = harness(); await test.console.handleCallback(9001, "ac:c:r:2:30"); expect(test.repository.updates[0]).toMatchObject({ source: "telegram_it_console", actor: 1 });
  });
  it("18. rejects malformed and unknown callback payloads", async () => {
    const test = harness(); expect((await test.console.handleCallback(9001, "ac:c:a:not-an-id")).text).toBe("Perintah tidak tersedia."); expect(test.repository.updates).toHaveLength(0);
  });
  it("19. reauthorizes every callback", async () => {
    const test = harness(); await test.console.handleCallback(9001, "ac:u"); await test.console.handleCallback(9001, "ac:s"); expect(test.channels.findByExternalIdentity).toHaveBeenCalledTimes(2);
  });
  it("20. returns a safe message when final SYSTEM_ADMIN deactivation is rejected", async () => {
    expect((await harness().console.handleCallback(9001, "ac:c:z:1")).text).toContain("SYSTEM_ADMIN aktif terakhir");
  });
  it("21. never exposes Telegram external identity or username in lists", async () => {
    const text = (await harness().console.handleCallback(9001, "ac:l:p:0")).text; expect(text).not.toContain("9001"); expect(text).not.toContain("username");
  });
  it("22. bot routes /admin using sender identity and inline keyboard", async () => {
    const console = harness().console; const sender = { sendMessage: vi.fn() };
    const bot = new TelegramBot("token", new TelegramRegistrationService({ upsertTelegramRegistration: vi.fn() }), { resolveByLegacyTelegramUserId: vi.fn() }, sender, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, console);
    await bot.handleUpdate({ update_id: 1, message: { text: "/admin", chat: { id: 7001 }, from: { id: 9001 } } });
    expect(sender.sendMessage).toHaveBeenCalledWith(7001, "Gwens IT Console", expect.objectContaining({ inlineKeyboard: expect.any(Array) }));
  });
  it("23. existing /start response remains unchanged", async () => {
    const legacy = { id: 1, telegram_chat_id: 7001, telegram_username: null, telegram_first_name: "IT", name: null,
      division: "IT", role: "Admin", active: true, stock_alert: false, purchase_alert: false, sales_alert: false,
      marketing_alert: false, content_alert: false, owner_report: false, system_error: false, created_at: now, updated_at: now };
    const sender = { sendMessage: vi.fn() };
    const bot = new TelegramBot("token", new TelegramRegistrationService({ upsertTelegramRegistration: vi.fn().mockResolvedValue(legacy) }),
      { resolveByLegacyTelegramUserId: vi.fn().mockResolvedValue({ status: "ACTIVE", active: true, divisionId: 10, roleId: 40, divisionCode: "IT", roleCode: "ADMIN" }) }, sender, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, harness().console);
    await bot.handleUpdate({ update_id: 1, message: { text: "/start", chat: { id: 7001 }, from: { id: 9001, first_name: "IT" } } });
    expect(sender.sendMessage).toHaveBeenCalledWith(7001, "Akun Gwens aktif.\n\nDivisi: IT\nRole: ADMIN\nStatus: Aktif");
  });
});
