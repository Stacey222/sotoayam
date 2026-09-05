import { AppError } from "../errors.js";
import type { SystemAuthorityRepository } from "../repositories/system-authority.repository.js";
import type { UserChannelsRepository } from "../repositories/user-channels.repository.js";
import type { UserManagementService } from "../services/user-management.service.js";
import type { TelegramInlineButton } from "../services/telegram.service.js";
import type { ManagedUser, UserManagementStatus } from "../user-management/types.js";
import type { CollaborationRuleReader } from "../services/collaboration-rule-management.service.js";
import { normalizeBusinessUserCode } from "../identity/business-user-code.js";
import type { TaskActor } from "../tasks/types.js";

export interface TelegramConsoleResponse {
  text: string;
  inlineKeyboard?: TelegramInlineButton[][];
}

export interface TelegramItConsole {
  open(externalTelegramId: number): Promise<TelegramConsoleResponse>;
  handleCallback(externalTelegramId: number, data: string): Promise<TelegramConsoleResponse>;
  handleText(externalTelegramId: number, text: string): Promise<TelegramConsoleResponse | null>;
}

interface AuthorizedActor extends TaskActor { userId: number }

interface BusinessCodeState {
  actorUserId: number;
  targetUserId: number;
  proposedCode: string | null | undefined;
  expiresAt: number;
}

const unavailable = (): TelegramConsoleResponse => ({ text: "Perintah tidak tersedia." });
const button = (text: string, callback_data: string): TelegramInlineButton => ({ text, callback_data });
const PAGE_SIZE = 5;

export class TelegramItConsoleService implements TelegramItConsole {
  private readonly businessCodeStates = new Map<number, BusinessCodeState>();
  constructor(
    private readonly channels: UserChannelsRepository,
    private readonly authorities: SystemAuthorityRepository,
    private readonly users: UserManagementService,
    private readonly collaborationRules?: CollaborationRuleReader,
  ) {}

  async open(externalTelegramId: number): Promise<TelegramConsoleResponse> {
    const actor = await this.authorize(externalTelegramId);
    return actor ? this.mainMenu() : unavailable();
  }

  async handleCallback(externalTelegramId: number, data: string): Promise<TelegramConsoleResponse> {
    const actor = await this.authorize(externalTelegramId);
    if (!actor || data.length > 64) return unavailable();
    if (data === "ac:m") return this.mainMenu();
    if (data === "ac:u") return this.userMenu();
    if (data === "ac:s") return this.systemStatus();
    if (data === "ac:g") return this.collaborationMenu();
    if (data === "ac:gv") return this.collaborationList(actor);

    let match = /^ac:l:(p|a|i):(\d+)$/.exec(data);
    if (match) return this.userList(this.status(match[1]!), Number(match[2]));
    match = /^ac:d:(\d+):(p|a|i):(\d+)$/.exec(data);
    if (match) return this.userDetail(Number(match[1]), this.status(match[2]!), Number(match[3]));
    match = /^ac:x:(d|r):(\d+)$/.exec(data);
    if (match) return this.catalog(match[1]!, Number(match[2]));
    match = /^ac:v:(d|r):(\d+):(\d+)$/.exec(data);
    if (match) return this.assignmentPreview(match[1]!, Number(match[2]), Number(match[3]));
    match = /^ac:c:(d|r):(\d+):(\d+)$/.exec(data);
    if (match) return this.assign(actor, match[1]!, Number(match[2]), Number(match[3]));
    match = /^ac:v:(a|z):(\d+)$/.exec(data);
    if (match) return this.activePreview(match[1]!, Number(match[2]));
    match = /^ac:c:(a|z):(\d+)$/.exec(data);
    if (match) return this.setActive(actor, match[1]!, Number(match[2]));
    match = /^ac:kb:(\d+)$/.exec(data);
    if (match) return this.beginBusinessCode(externalTelegramId, actor, Number(match[1]));
    match = /^ac:kc:(\d+)$/.exec(data);
    if (match) return this.confirmBusinessCode(externalTelegramId, actor, Number(match[1]));
    return unavailable();
  }

  async handleText(externalTelegramId: number, rawText: string): Promise<TelegramConsoleResponse | null> {
    const state = this.businessCodeStates.get(externalTelegramId);
    if (!state) return null;
    const actor = await this.authorize(externalTelegramId);
    if (!actor || actor.userId !== state.actorUserId || state.expiresAt < Date.now()) {
      this.businessCodeStates.delete(externalTelegramId);
      return null;
    }
    const value = rawText.trim();
    if (/^\/cancel$/i.test(value)) {
      this.businessCodeStates.delete(externalTelegramId);
      return { text: "Perubahan business user code dibatalkan.", inlineKeyboard: [[button("Back", `ac:d:${state.targetUserId}:a:0`)]] };
    }
    try {
      state.proposedCode = /^NONE$/i.test(value) ? null : normalizeBusinessUserCode(value);
      state.expiresAt = Date.now() + 5 * 60_000;
      return { text: `Konfirmasi Business User Code\n\nNilai baru: ${state.proposedCode ?? "Belum ditetapkan"}\n\nPerubahan kode yang sudah ada dapat memengaruhi integrasi.`,
        inlineKeyboard: [[button("Confirm", `ac:kc:${state.targetUserId}`), button("Cancel", `ac:d:${state.targetUserId}:a:0`)]] };
    } catch (error) {
      if (error instanceof AppError && error.code === "BUSINESS_USER_CODE_INVALID") {
        return { text: `${error.message}\n\nKirim kode yang valid, NONE untuk menghapus, atau /cancel.` };
      }
      throw error;
    }
  }

  private async authorize(externalTelegramId: number): Promise<AuthorizedActor | null> {
    if (!Number.isSafeInteger(externalTelegramId) || externalTelegramId <= 0) return null;
    const channel = await this.channels.findByExternalIdentity("TELEGRAM", String(externalTelegramId));
    if (!channel?.active) return null;
    const user = await this.users.get(channel.user_id).catch(() => null);
    if (!user?.active || user.division?.code !== "IT") return null;
    const authority = await this.authorities.findActiveForUser(user.id);
    return authority ? {
      userId: user.id, id: user.id, displayName: user.display_name, active: user.active,
      divisionId: user.division?.id ?? null, divisionCode: user.division?.code ?? null,
      roleId: user.role?.id ?? null, roleCode: user.role?.code ?? null, permissions: new Set(),
    } : null;
  }

  private mainMenu(): TelegramConsoleResponse {
    return { text: "Gwens IT Console", inlineKeyboard: [
      [button("User Management", "ac:u"), button("System Status", "ac:s")],
      [button("Collaboration Rules", "ac:g")],
    ] };
  }

  private userMenu(): TelegramConsoleResponse {
    return {
      text: "User Management",
      inlineKeyboard: [
        [button("Pending Users", "ac:l:p:0")],
        [button("Active Users", "ac:l:a:0"), button("Inactive Users", "ac:l:i:0")],
        [button("Back", "ac:m")],
      ],
    };
  }

  private systemStatus(): TelegramConsoleResponse {
    return { text: "System Status\n\nRuntime: Aktif\nUser Management: Tersedia", inlineKeyboard: [[button("Back", "ac:m")]] };
  }

  private collaborationMenu(): TelegramConsoleResponse {
    return { text: "Collaboration Rules", inlineKeyboard: [[button("View Rules", "ac:gv")], [button("Back", "ac:m")]] };
  }

  private async collaborationList(actor: AuthorizedActor): Promise<TelegramConsoleResponse> {
    if (!this.collaborationRules) return unavailable();
    const rules = await this.collaborationRules.list(actor);
    const text = rules.length === 0 ? "Collaboration Rules\n\nTidak ada rule."
      : `Collaboration Rules\n\n${rules.map((rule) => `${rule.source_division.code} → ${rule.target_division.code}\nAllowed: ${rule.allowed ? "Yes" : "No"}\nApproval: ${rule.requires_approval ? "Required" : "No"}\nStatus: ${rule.active ? "Active" : "Inactive"}`).join("\n\n")}`;
    return { text, inlineKeyboard: [[button("Back", "ac:g")]] };
  }

  private async userList(status: UserManagementStatus, requestedPage: number): Promise<TelegramConsoleResponse> {
    const users = await this.users.list(status);
    const pages = Math.max(1, Math.ceil(users.length / PAGE_SIZE));
    const page = Math.min(requestedPage, pages - 1);
    const visible = users.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const title = status === "pending" ? "Pending Users" : status === "active" ? "Active Users" : "Inactive Users";
    const text = visible.length === 0
      ? `${title}\n\nTidak ada user.`
      : `${title}\n\n${visible.map((user, index) => this.userSummary(user, page * PAGE_SIZE + index + 1)).join("\n\n")}\n\nHalaman ${page + 1}/${pages}`;
    const code = this.statusCode(status);
    const keyboard: TelegramInlineButton[][] = visible.map((user) => [button(this.safeName(user), `ac:d:${user.id}:${code}:${page}`)]);
    const navigation: TelegramInlineButton[] = [];
    if (page > 0) navigation.push(button("Previous", `ac:l:${code}:${page - 1}`));
    if (page + 1 < pages) navigation.push(button("Next", `ac:l:${code}:${page + 1}`));
    if (navigation.length) keyboard.push(navigation);
    keyboard.push([button("Back", "ac:u")]);
    return { text, inlineKeyboard: keyboard };
  }

  private async userDetail(id: number, status: UserManagementStatus, page: number): Promise<TelegramConsoleResponse> {
    const user = await this.safeUser(id);
    if (!user) return unavailable();
    return this.userDetailResponse(user, status, page);
  }

  private userDetailResponse(user: ManagedUser, status: UserManagementStatus, page: number, notice?: string): TelegramConsoleResponse {
    const id = user.id;
    const actions: TelegramInlineButton[][] = [
      [button("Assign Division", `ac:x:d:${id}`), button("Assign Role", `ac:x:r:${id}`)],
      [button("Business User Code", `ac:kb:${id}`)],
      [user.active ? button("Deactivate", `ac:v:z:${id}`) : button("Activate", `ac:v:a:${id}`)],
      [button("Back", `ac:l:${this.statusCode(status)}:${page}`)],
    ];
    return { text: `${notice ? `${notice}\n\n` : ""}User Detail\n\n${this.userDetailText(user)}`, inlineKeyboard: actions };
  }

  private async beginBusinessCode(externalTelegramId: number, actor: AuthorizedActor, id: number): Promise<TelegramConsoleResponse> {
    const user = await this.safeUser(id);
    if (!user) return unavailable();
    this.businessCodeStates.set(externalTelegramId, { actorUserId: actor.userId, targetUserId: id, proposedCode: undefined, expiresAt: Date.now() + 5 * 60_000 });
    return { text: `Business User Code\n\nUser: ${this.safeName(user)}\nCurrent: ${user.business_user_code ?? "Belum ditetapkan"}\n\nKirim kode baru (3-40 karakter, huruf/angka/hyphen, diawali huruf). Kirim NONE untuk menghapus atau /cancel.` };
  }

  private async confirmBusinessCode(externalTelegramId: number, actor: AuthorizedActor, id: number): Promise<TelegramConsoleResponse> {
    const state = this.businessCodeStates.get(externalTelegramId);
    if (!state || state.actorUserId !== actor.userId || state.targetUserId !== id || state.proposedCode === undefined || state.expiresAt < Date.now()) {
      this.businessCodeStates.delete(externalTelegramId);
      return unavailable();
    }
    const updated = await this.users.updateBusinessUserCode(id, { business_user_code: state.proposedCode, confirm_change: true }, "telegram_it_console", actor.userId);
    this.businessCodeStates.delete(externalTelegramId);
    return this.userDetailResponse(updated, this.category(updated), 0, "Business user code berhasil diperbarui.");
  }

  private async catalog(kind: string, id: number): Promise<TelegramConsoleResponse> {
    const user = await this.safeUser(id);
    if (!user) return unavailable();
    const catalogs = await this.users.catalogs();
    const entries = kind === "d" ? catalogs.divisions : catalogs.roles;
    return {
      text: `${kind === "d" ? "Assign Division" : "Assign Role"}\n\nUser: ${this.safeName(user)}\nPilih dari katalog aktif:`,
      inlineKeyboard: [
        ...entries.map((entry) => [button(entry.name, `ac:v:${kind}:${id}:${entry.id}`)]),
        [button("Cancel", `ac:d:${id}:${this.statusCode(this.category(user))}:0`)],
      ],
    };
  }

  private async assignmentPreview(kind: string, id: number, catalogId: number): Promise<TelegramConsoleResponse> {
    const [user, catalogs] = await Promise.all([this.safeUser(id), this.users.catalogs()]);
    if (!user) return unavailable();
    const entry = (kind === "d" ? catalogs.divisions : catalogs.roles).find((item) => item.id === catalogId);
    if (!entry) return unavailable();
    const label = kind === "d" ? "New Division" : "New Role";
    return {
      text: `Konfirmasi Perubahan\n\nUser: ${this.safeName(user)}\n${label}: ${entry.code}`,
      inlineKeyboard: [[button("Confirm", `ac:c:${kind}:${id}:${catalogId}`), button("Cancel", `ac:d:${id}:${this.statusCode(this.category(user))}:0`)]],
    };
  }

  private async assign(actor: AuthorizedActor, kind: string, id: number, catalogId: number): Promise<TelegramConsoleResponse> {
    const [user, catalogs] = await Promise.all([this.safeUser(id), this.users.catalogs()]);
    if (!user) return unavailable();
    const entry = (kind === "d" ? catalogs.divisions : catalogs.roles).find((item) => item.id === catalogId);
    if (!entry) return unavailable();
    const updated = await this.users.updateAccess(id, {
      division_id: kind === "d" ? catalogId : user.division?.id ?? null,
      role_id: kind === "r" ? catalogId : user.role?.id ?? null,
      active: user.active,
    }, "telegram_it_console", actor.userId);
    return this.userDetailResponse(updated, this.category(updated), 0, `${kind === "d" ? "Division" : "Role"} berhasil diperbarui.`);
  }

  private async activePreview(kind: string, id: number): Promise<TelegramConsoleResponse> {
    const user = await this.safeUser(id);
    if (!user) return unavailable();
    if (kind === "a" && (!user.division || !user.role)) {
      return { text: "User belum dapat diaktifkan. Tetapkan Divisi dan Role terlebih dahulu.", inlineKeyboard: [[button("Back", `ac:d:${id}:${this.statusCode(this.category(user))}:0`)]] };
    }
    const verb = kind === "a" ? "Activate" : "Deactivate";
    return {
      text: `${verb} user?\n\nUser: ${this.safeName(user)}\nDivision: ${user.division?.code ?? "Belum ditetapkan"}\nRole: ${user.role?.code ?? "Belum ditetapkan"}`,
      inlineKeyboard: [[button(verb, `ac:c:${kind}:${id}`), button("Cancel", `ac:d:${id}:${this.statusCode(this.category(user))}:0`)]],
    };
  }

  private async setActive(actor: AuthorizedActor, kind: string, id: number): Promise<TelegramConsoleResponse> {
    const user = await this.safeUser(id);
    if (!user) return unavailable();
    const active = kind === "a";
    if (active && (!user.division || !user.role)) {
      return { text: "User belum dapat diaktifkan. Tetapkan Divisi dan Role terlebih dahulu." };
    }
    try {
      const updated = await this.users.updateAccess(id, {
        division_id: user.division?.id ?? null,
        role_id: user.role?.id ?? null,
        active,
      }, "telegram_it_console", actor.userId);
      return this.userDetailResponse(updated, this.category(updated), 0, `User berhasil ${active ? "diaktifkan" : "dinonaktifkan"}.`);
    } catch (error) {
      if (error instanceof AppError && error.code === "GOVERNANCE_INVARIANT") {
        return { text: "User ini tidak dapat dinonaktifkan karena merupakan SYSTEM_ADMIN aktif terakhir.", inlineKeyboard: [[button("Back", "ac:u")]] };
      }
      throw error;
    }
  }

  private async safeUser(id: number): Promise<ManagedUser | null> {
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    return this.users.get(id).catch((error: unknown) => {
      if (error instanceof AppError && error.statusCode === 404) return null;
      throw error;
    });
  }

  private userSummary(user: ManagedUser, index: number): string {
    return `${index}. ${this.safeName(user)}\nDivision: ${user.division?.code ?? "Belum ditetapkan"}\nRole: ${user.role?.code ?? "Belum ditetapkan"}\nStatus: ${user.active ? "Aktif" : "Tidak aktif"}\nTelegram Connected: ${user.telegram_connected ? "Yes" : "No"}`;
  }

  private userDetailText(user: ManagedUser): string {
    return `Name: ${this.safeName(user)}\nBusiness User Code: ${user.business_user_code ?? "Belum ditetapkan"}\nTelegram Connected: ${user.telegram_connected ? "Yes" : "No"}\nDivision: ${user.division?.code ?? "Belum ditetapkan"}\nRole: ${user.role?.code ?? "Belum ditetapkan"}\nStatus: ${user.active ? "Aktif" : "Tidak aktif"}`;
  }

  private safeName(user: ManagedUser): string {
    return user.display_name?.trim() || "User tanpa nama";
  }

  private category(user: ManagedUser): UserManagementStatus {
    if (user.active) return "active";
    return user.division && user.role ? "inactive" : "pending";
  }

  private status(code: string): UserManagementStatus {
    return code === "a" ? "active" : code === "i" ? "inactive" : "pending";
  }

  private statusCode(status: UserManagementStatus): "p" | "a" | "i" {
    return status === "active" ? "a" : status === "inactive" ? "i" : "p";
  }
}
