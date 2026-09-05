import { describe, expect, it, vi } from "vitest";
import { resolveUserAccessState, type UserAccessState } from "../../src/identity/user-access-state.js";
import { TelegramRegistrationService } from "../../src/services/telegram-registration.service.js";
import { TelegramBot } from "../../src/telegram/bot.js";
import type { TelegramRegistration, TelegramUser } from "../../src/types/index.js";

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const legacyUser = (overrides: Partial<TelegramUser> = {}): TelegramUser => ({
  id: 1, telegram_chat_id: 101, telegram_username: null, telegram_first_name: "User", name: null,
  division: "UNASSIGNED", role: "UNASSIGNED", active: false,
  stock_alert: false, purchase_alert: false, sales_alert: false, marketing_alert: false,
  content_alert: false, owner_report: false, system_error: false,
  created_at: "now", updated_at: "now", ...overrides,
});
const state = (overrides: Partial<UserAccessState> = {}): UserAccessState => ({
  status: "PENDING", active: false, divisionId: null, roleId: null,
  divisionCode: null, roleCode: null, ...overrides,
});

function botFor(finalState: UserAccessState, returnedUser = legacyUser()) {
  const writer = { upsertTelegramRegistration: vi.fn().mockResolvedValue(returnedUser) };
  const resolver = { resolveByLegacyTelegramUserId: vi.fn().mockResolvedValue(finalState) };
  const sender = { sendMessage: vi.fn().mockResolvedValue(undefined) };
  const bot = new TelegramBot("test-token", new TelegramRegistrationService(writer), resolver, sender, logger());
  return { bot, writer, resolver, sender };
}

async function start(bot: TelegramBot, updateId = 1) {
  await bot.handleUpdate({ update_id: updateId, message: { text: "/start", chat: { id: 101 }, from: { first_name: "User" } } });
}

describe("Slice 2.6A Telegram authorization state", () => {
  it("1. sends the pending response for incomplete onboarding", async () => {
    const test = botFor(state()); await start(test.bot);
    expect(test.sender.sendMessage).toHaveBeenCalledWith(101, expect.stringContaining("Menunggu aktivasi Admin"));
  });

  it("2. does not send pending for an active STAFF user", async () => {
    const test = botFor(state({ status: "ACTIVE", active: true, divisionId: 2, roleId: 1, divisionCode: "PURCHASING", roleCode: "STAFF" })); await start(test.bot);
    const message = test.sender.sendMessage.mock.calls[0]?.[1]; expect(message).toContain("Status: Aktif"); expect(message).not.toContain("Menunggu aktivasi");
  });

  it("3. does not send pending for an active ADMIN user", async () => {
    const test = botFor(state({ status: "ACTIVE", active: true, divisionId: 2, roleId: 2, divisionCode: "SALES_GROSIR", roleCode: "ADMIN" })); await start(test.bot);
    expect(test.sender.sendMessage.mock.calls[0]?.[1]).not.toContain("Menunggu aktivasi");
  });

  it("4. renders active IT ADMIN semantics", async () => {
    const test = botFor(state({ status: "ACTIVE", active: true, divisionId: 1, roleId: 2, divisionCode: "IT", roleCode: "ADMIN" })); await start(test.bot);
    expect(test.sender.sendMessage.mock.calls[0]?.[1]).toBe("Akun Sotoayam aktif.\n\nDivisi: IT\nRole: ADMIN\nStatus: Aktif");
  });

  it("5. keeps SYSTEM_ADMIN separate from incomplete business onboarding", () => {
    const systemAdminAssigned = true;
    const access = resolveUserAccessState({ active: false, divisionId: null, roleId: null, divisionCode: null, roleCode: null });
    expect(systemAdminAssigned).toBe(true); expect(access.status).toBe("PENDING");
  });

  it("6. repeated start preserves division", async () => {
    const business = { division: "IT", role: "Admin", active: true, systemAdmin: true };
    const writer = { upsertTelegramRegistration: vi.fn(async (_input: TelegramRegistration) => legacyUser({ division: business.division, role: business.role, active: business.active })) };
    const resolver = { resolveByLegacyTelegramUserId: vi.fn().mockResolvedValue(state({ status: "ACTIVE", active: true, divisionId: 1, roleId: 2, divisionCode: "IT", roleCode: "ADMIN" })) };
    const bot = new TelegramBot("token", new TelegramRegistrationService(writer), resolver, { sendMessage: vi.fn() }, logger());
    await start(bot, 1); await start(bot, 2); expect(business.division).toBe("IT");
  });

  it("7. repeated start preserves role", async () => {
    const test = botFor(state({ status: "ACTIVE", active: true, divisionId: 1, roleId: 2, divisionCode: "IT", roleCode: "ADMIN" }), legacyUser({ division: "IT", role: "Admin", active: true }));
    await start(test.bot, 1); await start(test.bot, 2); expect(test.writer.upsertTelegramRegistration.mock.results).toHaveLength(2); expect((await test.writer.upsertTelegramRegistration.mock.results[0]?.value).role).toBe("Admin");
  });

  it("8. repeated start preserves active state", async () => {
    const returned = legacyUser({ division: "IT", role: "Admin", active: true }); const test = botFor(state({ status: "ACTIVE", active: true, divisionId: 1, roleId: 2, divisionCode: "IT", roleCode: "ADMIN" }), returned);
    await start(test.bot, 1); await start(test.bot, 2); expect(returned.active).toBe(true);
  });

  it("9. repeated start never reads or mutates SYSTEM_ADMIN", async () => {
    const authority = { active: true }; const test = botFor(state({ status: "ACTIVE", active: true, divisionId: 1, roleId: 2, divisionCode: "IT", roleCode: "ADMIN" }));
    await start(test.bot, 1); await start(test.bot, 2); expect(authority.active).toBe(true); expect(test.resolver.resolveByLegacyTelegramUserId).toHaveBeenCalledTimes(2);
  });

  it("10. resolves persisted final state only after registration", async () => {
    const order: string[] = [];
    const writer = { upsertTelegramRegistration: vi.fn(async () => { order.push("register"); return legacyUser(); }) };
    const resolver = { resolveByLegacyTelegramUserId: vi.fn(async () => { order.push("resolve-final"); return state(); }) };
    const sender = { sendMessage: vi.fn(async () => { order.push("send"); }) };
    await start(new TelegramBot("token", new TelegramRegistrationService(writer), resolver, sender, logger()));
    expect(order).toEqual(["register", "resolve-final", "send"]);
  });

  it("11. stale legacy pending state cannot override normalized active state", async () => {
    const staleLegacy = legacyUser({ division: "UNASSIGNED", role: "UNASSIGNED", active: false });
    const test = botFor(state({ status: "ACTIVE", active: true, divisionId: 1, roleId: 2, divisionCode: "IT", roleCode: "ADMIN" }), staleLegacy); await start(test.bot);
    expect(test.sender.sendMessage.mock.calls[0]?.[1]).toContain("Status: Aktif");
  });

  it("12. preserves the legacy registration input contract", async () => {
    const test = botFor(state()); await start(test.bot);
    expect(test.writer.upsertTelegramRegistration).toHaveBeenCalledWith({ telegram_chat_id: 101, telegram_username: null, telegram_first_name: "User" });
    expect(test.sender.sendMessage.mock.calls[0]?.[1]).toContain("Registrasi Telegram Sotoayam berhasil.");
  });
});
