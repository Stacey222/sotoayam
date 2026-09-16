import { AppError } from "../errors.js";
import type { SystemAuthorityRepository } from "../repositories/system-authority.repository.js";
import type { UserChannelsRepository } from "../repositories/user-channels.repository.js";
import type { UserManagementService } from "../services/user-management.service.js";
import type { TelegramInlineButton } from "../services/telegram.service.js";
import type { ManagedUser, UserManagementStatus } from "../user-management/types.js";
import type { CollaborationRuleReader } from "../services/collaboration-rule-management.service.js";
import { normalizeBusinessUserCode } from "../identity/business-user-code.js";
import { hasSystemAdminCapability } from "../auth/system-admin-capability.js";
import { commonMessages, formatActivePreview, formatAssignmentPreview, formatAssignmentUpdated, formatBusinessCodeConfirmation,
  formatBusinessCodePrompt, formatCatalogPrompt, formatCollaborationRules, formatUserActiveNotice,
  formatUserDetail, formatUserDetailResponse, formatUserList, formatUserSummary, safeUserName,
  telegramButtons, telegramItMessages } from "../messages/catalog.js";

export interface TelegramConsoleResponse {
  text: string;
  inlineKeyboard?: TelegramInlineButton[][];
}

export interface TelegramItConsole {
  open(externalTelegramId: number): Promise<TelegramConsoleResponse>;
  handleCallback(externalTelegramId: number, data: string): Promise<TelegramConsoleResponse>;
  handleText(externalTelegramId: number, text: string): Promise<TelegramConsoleResponse | null>;
}

interface AuthorizedActor {
  userId: number;
}

interface BusinessCodeState {
  actorUserId: number;
  targetUserId: number;
  proposedCode: string | null | undefined;
  expiresAt: number;
}

const unavailable = (): TelegramConsoleResponse => ({ text: commonMessages.commandUnavailable });
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
    if (data === "ac:gv") return this.collaborationList();

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
      return { text: telegramItMessages.businessCodeCancelled, inlineKeyboard: [[button(telegramButtons.back, `ac:d:${state.targetUserId}:a:0`)]] };
    }
    try {
      state.proposedCode = /^NONE$/i.test(value) ? null : normalizeBusinessUserCode(value);
      state.expiresAt = Date.now() + 5 * 60_000;
      return { text: formatBusinessCodeConfirmation(state.proposedCode),
        inlineKeyboard: [[button(telegramButtons.confirm, `ac:kc:${state.targetUserId}`), button(telegramButtons.cancel, `ac:d:${state.targetUserId}:a:0`)]] };
    } catch (error) {
      if (error instanceof AppError && error.code === "BUSINESS_USER_CODE_INVALID") {
        return { text: `${error.message}\n\n${telegramItMessages.businessCodeInputHelp}` };
      }
      throw error;
    }
  }

  private async authorize(externalTelegramId: number): Promise<AuthorizedActor | null> {
    if (!Number.isSafeInteger(externalTelegramId) || externalTelegramId <= 0) return null;
    const channel = await this.channels.findByExternalIdentity("TELEGRAM", String(externalTelegramId));
    if (!channel?.active) return null;
    const user = await this.users.get(channel.user_id).catch(() => null);
    if (!user || !hasSystemAdminCapability({
      active: user.active,
      divisionId: user.division?.id ?? null,
      roleId: user.role?.id ?? null,
      divisionGrantsSystemAuthority: user.division?.grants_system_authority,
    })) return null;
    const authority = await this.authorities.findActiveForUser(user.id);
    return authority ? { userId: user.id } : null;
  }

  private mainMenu(): TelegramConsoleResponse {
    return { text: telegramItMessages.title, inlineKeyboard: [
      [button(telegramItMessages.menu.userManagement, "ac:u"), button(telegramItMessages.menu.systemStatus, "ac:s")],
      [button(telegramItMessages.menu.collaborationRules, "ac:g")],
    ] };
  }

  private userMenu(): TelegramConsoleResponse {
    return {
      text: telegramItMessages.menu.userManagement,
      inlineKeyboard: [
        [button(telegramItMessages.buttons.pendingUsers, "ac:l:p:0")],
        [button(telegramItMessages.buttons.activeUsers, "ac:l:a:0"), button(telegramItMessages.buttons.inactiveUsers, "ac:l:i:0")],
        [button(telegramButtons.back, "ac:m")],
      ],
    };
  }

  private systemStatus(): TelegramConsoleResponse {
    return { text: telegramItMessages.systemStatus, inlineKeyboard: [[button(telegramButtons.back, "ac:m")]] };
  }

  private collaborationMenu(): TelegramConsoleResponse {
    return { text: telegramItMessages.menu.collaborationRules, inlineKeyboard: [[button(telegramItMessages.buttons.viewRules, "ac:gv")], [button(telegramButtons.back, "ac:m")]] };
  }

  private async collaborationList(): Promise<TelegramConsoleResponse> {
    if (!this.collaborationRules) return unavailable();
    const rules = await this.collaborationRules.list();
    const text = formatCollaborationRules(rules.map((rule) => ({ source: rule.source_division.code,
      target: rule.target_division.code, allowed: rule.allowed, requiresApproval: rule.requires_approval, active: rule.active })));
    return { text, inlineKeyboard: [[button(telegramButtons.back, "ac:g")]] };
  }

  private async userList(status: UserManagementStatus, requestedPage: number): Promise<TelegramConsoleResponse> {
    const users = await this.users.list(status);
    const pages = Math.max(1, Math.ceil(users.length / PAGE_SIZE));
    const page = Math.min(requestedPage, pages - 1);
    const visible = users.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const text = formatUserList(status, visible.map((user, index) => formatUserSummary(user, page * PAGE_SIZE + index + 1)), page, pages);
    const code = this.statusCode(status);
    const keyboard: TelegramInlineButton[][] = visible.map((user) => [button(this.safeName(user), `ac:d:${user.id}:${code}:${page}`)]);
    const navigation: TelegramInlineButton[] = [];
    if (page > 0) navigation.push(button(telegramButtons.previous, `ac:l:${code}:${page - 1}`));
    if (page + 1 < pages) navigation.push(button(telegramButtons.next, `ac:l:${code}:${page + 1}`));
    if (navigation.length) keyboard.push(navigation);
    keyboard.push([button(telegramButtons.back, "ac:u")]);
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
      [button(telegramItMessages.buttons.assignDivision, `ac:x:d:${id}`), button(telegramItMessages.buttons.assignRole, `ac:x:r:${id}`)],
      [button(telegramItMessages.buttons.businessUserCode, `ac:kb:${id}`)],
      [user.active ? button(telegramItMessages.buttons.deactivate, `ac:v:z:${id}`) : button(telegramItMessages.buttons.activate, `ac:v:a:${id}`)],
      [button(telegramButtons.back, `ac:l:${this.statusCode(status)}:${page}`)],
    ];
    return { text: formatUserDetailResponse(formatUserDetail(user), notice), inlineKeyboard: actions };
  }

  private async beginBusinessCode(externalTelegramId: number, actor: AuthorizedActor, id: number): Promise<TelegramConsoleResponse> {
    const user = await this.safeUser(id);
    if (!user) return unavailable();
    this.businessCodeStates.set(externalTelegramId, { actorUserId: actor.userId, targetUserId: id, proposedCode: undefined, expiresAt: Date.now() + 5 * 60_000 });
    return { text: formatBusinessCodePrompt(user) };
  }

  private async confirmBusinessCode(externalTelegramId: number, actor: AuthorizedActor, id: number): Promise<TelegramConsoleResponse> {
    const state = this.businessCodeStates.get(externalTelegramId);
    if (!state || state.actorUserId !== actor.userId || state.targetUserId !== id || state.proposedCode === undefined || state.expiresAt < Date.now()) {
      this.businessCodeStates.delete(externalTelegramId);
      return unavailable();
    }
    const updated = await this.users.updateBusinessUserCode(id, { business_user_code: state.proposedCode, confirm_change: true }, "telegram_it_console", actor.userId);
    this.businessCodeStates.delete(externalTelegramId);
    return this.userDetailResponse(updated, this.category(updated), 0, telegramItMessages.businessCodeUpdated);
  }

  private async catalog(kind: string, id: number): Promise<TelegramConsoleResponse> {
    const user = await this.safeUser(id);
    if (!user) return unavailable();
    const catalogs = await this.users.catalogs();
    const entries = kind === "d" ? catalogs.divisions : catalogs.roles;
    return {
      text: formatCatalogPrompt(kind, safeUserName(user)),
      inlineKeyboard: [
        ...entries.map((entry) => [button(entry.name, `ac:v:${kind}:${id}:${entry.id}`)]),
        [button(telegramButtons.cancel, `ac:d:${id}:${this.statusCode(this.category(user))}:0`)],
      ],
    };
  }

  private async assignmentPreview(kind: string, id: number, catalogId: number): Promise<TelegramConsoleResponse> {
    const [user, catalogs] = await Promise.all([this.safeUser(id), this.users.catalogs()]);
    if (!user) return unavailable();
    const entry = (kind === "d" ? catalogs.divisions : catalogs.roles).find((item) => item.id === catalogId);
    if (!entry) return unavailable();
    return {
      text: formatAssignmentPreview(kind, safeUserName(user), entry.code),
      inlineKeyboard: [[button(telegramButtons.confirm, `ac:c:${kind}:${id}:${catalogId}`), button(telegramButtons.cancel, `ac:d:${id}:${this.statusCode(this.category(user))}:0`)]],
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
    return this.userDetailResponse(updated, this.category(updated), 0, formatAssignmentUpdated(kind));
  }

  private async activePreview(kind: string, id: number): Promise<TelegramConsoleResponse> {
    const user = await this.safeUser(id);
    if (!user) return unavailable();
    if (kind === "a" && (!user.division || !user.role)) {
      return { text: telegramItMessages.activationUnavailable, inlineKeyboard: [[button(telegramButtons.back, `ac:d:${id}:${this.statusCode(this.category(user))}:0`)]] };
    }
    const verb = kind === "a" ? telegramItMessages.buttons.activate : telegramItMessages.buttons.deactivate;
    return {
      text: formatActivePreview(kind === "a", user),
      inlineKeyboard: [[button(verb, `ac:c:${kind}:${id}`), button(telegramButtons.cancel, `ac:d:${id}:${this.statusCode(this.category(user))}:0`)]],
    };
  }

  private async setActive(actor: AuthorizedActor, kind: string, id: number): Promise<TelegramConsoleResponse> {
    const user = await this.safeUser(id);
    if (!user) return unavailable();
    const active = kind === "a";
    if (active && (!user.division || !user.role)) {
      return { text: telegramItMessages.activationUnavailable };
    }
    try {
      const updated = await this.users.updateAccess(id, {
        division_id: user.division?.id ?? null,
        role_id: user.role?.id ?? null,
        active,
      }, "telegram_it_console", actor.userId);
      return this.userDetailResponse(updated, this.category(updated), 0, formatUserActiveNotice(active));
    } catch (error) {
      if (error instanceof AppError && error.code === "SELF_DEACTIVATION_FORBIDDEN") {
        return { text: telegramItMessages.selfDeactivationForbidden,
          inlineKeyboard: [[button(telegramButtons.back, "ac:u")]] };
      }
      if (error instanceof AppError && ["GOVERNANCE_INVARIANT", "LAST_SYSTEM_ADMIN"].includes(error.code)) {
        return { text: telegramItMessages.lastSystemAdmin, inlineKeyboard: [[button(telegramButtons.back, "ac:u")]] };
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

  private safeName(user: ManagedUser): string {
    return safeUserName(user);
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
