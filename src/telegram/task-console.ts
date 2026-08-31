import { AppError } from "../errors.js";
import type { DivisionsRepository } from "../repositories/divisions.repository.js";
import type { DivisionCollaborationRepository } from "../repositories/division-collaboration.repository.js";
import type { TaskDirectoryRepository } from "../repositories/task-users.repository.js";
import type { TelegramTaskActorResolver } from "../services/task-actor.service.js";
import type { TaskService } from "../services/task.service.js";
import type { TelegramInlineButton } from "../services/telegram.service.js";
import type { TaskActor, TaskPriority, TaskReadModel, TaskStatus } from "../tasks/types.js";
import type { TelegramConsoleResponse } from "./it-console.js";

export interface TelegramTaskConsole {
  open(externalTelegramId: number): Promise<TelegramConsoleResponse>;
  handleCallback(externalTelegramId: number, data: string): Promise<TelegramConsoleResponse>;
  handleText(externalTelegramId: number, text: string): Promise<TelegramConsoleResponse | null>;
}

type FilterCode = "o" | "i" | "b" | "c" | "a";
type CreateStep = "title" | "description" | "priority" | "owner" | "assignee" | "deadline" | "review" | "submitting";

interface NavigationContext { filter: FilterCode; page: number }
interface StateBase { actorId: number; expiresAt: number }
interface TaskInputState extends StateBase, NavigationContext { kind: "comment" | "block"; taskId: number }
interface CreateDraft {
  title?: string;
  description?: string | null;
  priority?: TaskPriority;
  ownerDivisionId?: number;
  assignedToUserId?: number | null;
  deadline?: string | null;
}
interface CreateState extends StateBase { kind: "create"; step: CreateStep; draft: CreateDraft }
type ConversationState = TaskInputState | CreateState;

const PAGE_SIZE = 5;
const STATE_TTL_MS = 15 * 60 * 1000;
const MAX_COMMENT = 2000;
const MAX_DESCRIPTION = 2000;
const ACTIVE_STATUSES: readonly TaskStatus[] = ["DRAFT", "OPEN", "IN_PROGRESS", "BLOCKED"];
const FILTERS: Readonly<Record<FilterCode, { label: string; statuses: readonly TaskStatus[] }>> = {
  o: { label: "Open", statuses: ["OPEN"] },
  i: { label: "In Progress", statuses: ["IN_PROGRESS"] },
  b: { label: "Blocked", statuses: ["BLOCKED"] },
  c: { label: "Completed", statuses: ["COMPLETED"] },
  a: { label: "All Active", statuses: ACTIVE_STATUSES },
};
const PRIORITIES: Readonly<Record<string, TaskPriority>> = { L: "LOW", N: "NORMAL", H: "HIGH", U: "URGENT" };

const button = (text: string, callback_data: string): TelegramInlineButton => ({ text, callback_data });
const unavailable = (): TelegramConsoleResponse => ({ text: "Perintah tidak tersedia." });

export class TelegramTaskConsoleService implements TelegramTaskConsole {
  private readonly states = new Map<number, ConversationState>();
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly service: TaskService,
    private readonly actors: TelegramTaskActorResolver,
    private readonly directory: TaskDirectoryRepository,
    private readonly divisions: DivisionsRepository,
    private readonly collaborationRules: DivisionCollaborationRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async open(externalTelegramId: number): Promise<TelegramConsoleResponse> {
    const actor = await this.authorize(externalTelegramId);
    if (!actor) return unavailable();
    this.states.delete(externalTelegramId);
    return this.mainMenu(actor);
  }

  async handleCallback(externalTelegramId: number, data: string): Promise<TelegramConsoleResponse> {
    const actor = await this.authorize(externalTelegramId);
    if (!actor || data.length > 64 || !data.startsWith("tc:")) return unavailable();
    try {
      if (data === "tc:m") { this.states.delete(externalTelegramId); return this.mainMenu(actor); }
      if (data === "tc:l") return this.filterMenu();
      if (data === "tc:c") return this.beginCreate(externalTelegramId, actor);
      if (data === "tc:ix") return await this.cancelInput(externalTelegramId, actor);
      if (data === "tc:cx") { this.states.delete(externalTelegramId); return this.mainMenu(actor, "Pembuatan task dibatalkan."); }

      let match = /^tc:p:(o|i|b|c|a):(\d+)$/.exec(data);
      if (match) return await this.taskList(actor, match[1] as FilterCode, Number(match[2]));
      match = /^tc:d:(\d+):(o|i|b|c|a):(\d+)$/.exec(data);
      if (match) return await this.taskDetail(actor, Number(match[1]), { filter: match[2] as FilterCode, page: Number(match[3]) });
      match = /^tc:t:(s|r|c):(\d+):(o|i|b|c|a):(\d+)$/.exec(data);
      if (match) return await this.transition(actor, match[1]!, Number(match[2]), { filter: match[3] as FilterCode, page: Number(match[4]) });
      match = /^tc:v:c:(\d+):(o|i|b|c|a):(\d+)$/.exec(data);
      if (match) return await this.completePreview(actor, Number(match[1]), { filter: match[2] as FilterCode, page: Number(match[3]) });
      match = /^tc:q:(c|b):(\d+):(o|i|b|c|a):(\d+)$/.exec(data);
      if (match) return await this.beginTaskInput(externalTelegramId, actor, match[1] === "c" ? "comment" : "block", Number(match[2]), { filter: match[3] as FilterCode, page: Number(match[4]) });

      if (data === "tc:cs:d") return this.skipDescription(externalTelegramId, actor);
      match = /^tc:cp:(L|N|H|U)$/.exec(data);
      if (match) return await this.choosePriority(externalTelegramId, actor, PRIORITIES[match[1]!]!);
      match = /^tc:co:(\d+)$/.exec(data);
      if (match) return await this.chooseOwner(externalTelegramId, actor, Number(match[1]));
      match = /^tc:ca:(\d+)$/.exec(data);
      if (match) return await this.chooseAssignee(externalTelegramId, actor, Number(match[1]));
      if (data === "tc:cd:s") return await this.skipDeadline(externalTelegramId, actor);
      if (data === "tc:cc") return await this.confirmCreate(externalTelegramId, actor);
      return unavailable();
    } catch (error) {
      return this.safeError(error);
    }
  }

  async handleText(externalTelegramId: number, rawText: string): Promise<TelegramConsoleResponse | null> {
    const actor = await this.authorize(externalTelegramId);
    if (!actor) { this.states.delete(externalTelegramId); return null; }
    const state = this.currentState(externalTelegramId, actor.id);
    if (!state) return null;
    const text = rawText.trim();
    if (/^\/cancel(?:\s|$)/i.test(text)) return this.cancelInput(externalTelegramId, actor);
    try {
      if (state.kind === "comment") return await this.submitComment(externalTelegramId, actor, state, text);
      if (state.kind === "block") return await this.submitBlock(externalTelegramId, actor, state, text);
      if (state.kind === "create") return await this.handleCreateText(externalTelegramId, actor, state, text);
      return null;
    } catch (error) {
      return this.safeError(error, [[button("Cancel", "tc:ix")]]);
    }
  }

  private async authorize(externalTelegramId: number): Promise<TaskActor | null> {
    try {
      return await this.actors.resolveTelegramActor(externalTelegramId);
    } catch (error) {
      if (error instanceof AppError && error.code === "TASK_FORBIDDEN") return null;
      throw error;
    }
  }

  private mainMenu(actor: TaskActor, notice?: string): TelegramConsoleResponse {
    const keyboard: TelegramInlineButton[][] = [[button("My Tasks", "tc:l")]];
    if (actor.permissions.has("task.create")) keyboard.push([button("Create Task", "tc:c")]);
    return { text: `${notice ? `${notice}\n\n` : ""}Gwens Task Console`, inlineKeyboard: keyboard };
  }

  private filterMenu(): TelegramConsoleResponse {
    return { text: "My Tasks\n\nPilih filter:", inlineKeyboard: [
      [button("Open", "tc:p:o:0"), button("In Progress", "tc:p:i:0")],
      [button("Blocked", "tc:p:b:0"), button("Completed", "tc:p:c:0")],
      [button("All Active", "tc:p:a:0")],
      [button("Back", "tc:m")],
    ] };
  }

  private async taskList(actor: TaskActor, filter: FilterCode, requestedPage: number): Promise<TelegramConsoleResponse> {
    const definition = FILTERS[filter];
    const tasks = (await this.service.list(actor, {})).filter((task) => definition.statuses.includes(task.status));
    const pages = Math.max(1, Math.ceil(tasks.length / PAGE_SIZE));
    const page = Math.max(0, Math.min(requestedPage, pages - 1));
    const visible = tasks.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const text = visible.length === 0
      ? `My Tasks · ${definition.label}\n\nTidak ada task.`
      : `My Tasks · ${definition.label}\n\n${visible.map((task) => this.taskSummary(task)).join("\n")}\n\nHalaman ${page + 1}/${pages}`;
    const keyboard = visible.map((task) => [button(`#${task.id} · ${this.compact(task.title, 35)}`, `tc:d:${task.id}:${filter}:${page}`)]);
    const navigation: TelegramInlineButton[] = [];
    if (page > 0) navigation.push(button("Previous", `tc:p:${filter}:${page - 1}`));
    if (page + 1 < pages) navigation.push(button("Next", `tc:p:${filter}:${page + 1}`));
    if (navigation.length) keyboard.push(navigation);
    keyboard.push([button("Back", "tc:l")]);
    return { text, inlineKeyboard: keyboard };
  }

  private async taskDetail(actor: TaskActor, taskId: number, context: NavigationContext, notice?: string): Promise<TelegramConsoleResponse> {
    const task = await this.service.get(actor, taskId);
    const [divisionEntries, assignee] = await Promise.all([
      this.divisions.findAll(),
      task.assigned_to_user_id ? this.directory.findById(task.assigned_to_user_id) : Promise.resolve(null),
    ]);
    const requesting = divisionEntries.find((item) => item.id === task.requesting_division_id)?.code ?? "Tidak tersedia";
    const owner = divisionEntries.find((item) => item.id === task.owner_division_id)?.code ?? "Tidak tersedia";
    const lines = [
      ...(notice ? [notice, ""] : []),
      `Task #${task.id}`,
      "",
      `Title: ${task.title}`,
      ...(task.description ? [`Description: ${this.compact(task.description, 800)}`] : []),
      `Status: ${task.status}`,
      `Priority: ${task.priority}`,
      `Requesting Divisi: ${requesting}`,
      `Owner Divisi: ${owner}`,
      `Assigned To: ${assignee?.displayName?.trim() || "Unassigned"}`,
      `Deadline: ${task.deadline ? task.deadline.slice(0, 10) : "None"}`,
      `Overdue: ${task.is_overdue ? "Yes" : "No"}`,
      `Created: ${task.created_at.slice(0, 10)}`,
    ];
    const actions: TelegramInlineButton[][] = [];
    const assigned = task.assigned_to_user_id === actor.id;
    const canUpdate = assigned && actor.permissions.has("task.update_assigned");
    const canComplete = assigned && actor.permissions.has("task.complete_assigned");
    const canComment = assigned && actor.permissions.has("task.add_activity");
    if (task.status === "OPEN" && canUpdate) actions.push([button("Start Task", this.action("t:s", task, context))]);
    if (task.status === "IN_PROGRESS" && canUpdate) actions.push([button("Block Task", this.action("q:b", task, context))]);
    if (task.status === "BLOCKED" && canUpdate) actions.push([button("Resume Task", this.action("t:r", task, context))]);
    if (["OPEN", "IN_PROGRESS", "BLOCKED"].includes(task.status) && canComplete) {
      actions.push([button("Complete Task", this.action("v:c", task, context))]);
    }
    if (canComment) actions.push([button("Add Comment", this.action("q:c", task, context))]);
    actions.push([button("Back", `tc:p:${context.filter}:${context.page}`)]);
    return { text: lines.join("\n"), inlineKeyboard: actions };
  }

  private async beginTaskInput(externalTelegramId: number, actor: TaskActor, kind: "comment" | "block", taskId: number, context: NavigationContext): Promise<TelegramConsoleResponse> {
    await this.service.get(actor, taskId);
    this.states.set(externalTelegramId, { kind, actorId: actor.id, taskId, ...context, expiresAt: this.expiresAt() });
    return {
      text: kind === "comment" ? `Task #${taskId}\n\nKirim komentar (maksimal ${MAX_COMMENT} karakter).` : `Task #${taskId}\n\nKirim alasan task diblokir.`,
      inlineKeyboard: [[button("Cancel", "tc:ix")]],
    };
  }

  private async submitComment(externalTelegramId: number, actor: TaskActor, state: TaskInputState, text: string): Promise<TelegramConsoleResponse> {
    if (!text || text.length > MAX_COMMENT) return { text: `Komentar wajib berisi 1-${MAX_COMMENT} karakter.`, inlineKeyboard: [[button("Cancel", "tc:ix")]] };
    const key = `${actor.id}:comment:${state.taskId}`;
    if (this.inFlight.has(key)) return { text: "Komentar sedang diproses." };
    this.inFlight.add(key);
    try {
      await this.service.addActivity(actor, state.taskId, { activityType: "COMMENT", note: text, visibility: "SHARED" });
      this.states.delete(externalTelegramId);
      return this.taskDetail(actor, state.taskId, state, "Komentar berhasil ditambahkan.");
    } finally { this.inFlight.delete(key); }
  }

  private async submitBlock(externalTelegramId: number, actor: TaskActor, state: TaskInputState, text: string): Promise<TelegramConsoleResponse> {
    if (!text || text.length > MAX_COMMENT) return { text: `Alasan wajib berisi 1-${MAX_COMMENT} karakter.`, inlineKeyboard: [[button("Cancel", "tc:ix")]] };
    const key = `${actor.id}:block:${state.taskId}`;
    if (this.inFlight.has(key)) return { text: "Perubahan status sedang diproses." };
    this.inFlight.add(key);
    try {
      await this.service.transition(actor, state.taskId, { status: "BLOCKED", note: text });
      this.states.delete(externalTelegramId);
      return this.taskDetail(actor, state.taskId, state, "Task berhasil diblokir.");
    } finally { this.inFlight.delete(key); }
  }

  private async transition(actor: TaskActor, action: string, taskId: number, context: NavigationContext): Promise<TelegramConsoleResponse> {
    const status = action === "s" || action === "r" ? "IN_PROGRESS" : "COMPLETED";
    const key = `${actor.id}:${status}:${taskId}`;
    if (this.inFlight.has(key)) return { text: "Perubahan status sedang diproses." };
    this.inFlight.add(key);
    try {
      await this.service.transition(actor, taskId, { status });
      const notice = status === "COMPLETED" ? "Task berhasil diselesaikan." : action === "r" ? "Task berhasil dilanjutkan." : "Task berhasil dimulai.";
      return this.taskDetail(actor, taskId, context, notice);
    } finally { this.inFlight.delete(key); }
  }

  private async completePreview(actor: TaskActor, taskId: number, context: NavigationContext): Promise<TelegramConsoleResponse> {
    const task = await this.service.get(actor, taskId);
    return { text: `Complete Task #${task.id}?\n\n${task.title}`, inlineKeyboard: [
      [button("Confirm Complete", this.action("t:c", task, context))],
      [button("Back", this.action("d", task, context))],
    ] };
  }

  private beginCreate(externalTelegramId: number, actor: TaskActor): TelegramConsoleResponse {
    if (!actor.permissions.has("task.create")) return unavailable();
    this.states.set(externalTelegramId, { kind: "create", actorId: actor.id, step: "title", draft: {}, expiresAt: this.expiresAt() });
    return { text: "Create Task\n\nKirim title task (maksimal 200 karakter).", inlineKeyboard: [[button("Cancel", "tc:cx")]] };
  }

  private async handleCreateText(externalTelegramId: number, actor: TaskActor, state: CreateState, text: string): Promise<TelegramConsoleResponse> {
    if (state.step === "title") {
      if (!text || text.length > 200) return { text: "Title wajib berisi 1-200 karakter.", inlineKeyboard: [[button("Cancel", "tc:cx")]] };
      state.draft.title = text; state.step = "description"; this.touch(state);
      return { text: "Kirim description task (maksimal 2000 karakter), atau pilih Skip.", inlineKeyboard: [[button("Skip", "tc:cs:d"), button("Cancel", "tc:cx")]] };
    }
    if (state.step === "description") {
      if (text.length > MAX_DESCRIPTION) return { text: `Description maksimal ${MAX_DESCRIPTION} karakter.`, inlineKeyboard: [[button("Skip", "tc:cs:d"), button("Cancel", "tc:cx")]] };
      state.draft.description = text || null; return this.priorityPrompt(state);
    }
    if (state.step === "deadline") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !this.validDate(text)) {
        return { text: "Deadline tidak valid. Gunakan format YYYY-MM-DD.", inlineKeyboard: [[button("Skip", "tc:cd:s"), button("Cancel", "tc:cx")]] };
      }
      state.draft.deadline = `${text}T23:59:59.999Z`; state.step = "review"; this.touch(state);
      return this.review(actor, state);
    }
    return unavailable();
  }

  private skipDescription(externalTelegramId: number, actor: TaskActor): TelegramConsoleResponse {
    const state = this.createState(externalTelegramId, actor.id, "description");
    if (!state) return unavailable();
    state.draft.description = null;
    return this.priorityPrompt(state);
  }

  private priorityPrompt(state: CreateState): TelegramConsoleResponse {
    state.step = "priority"; this.touch(state);
    return { text: "Pilih priority:", inlineKeyboard: [
      [button("LOW", "tc:cp:L"), button("NORMAL", "tc:cp:N")],
      [button("HIGH", "tc:cp:H"), button("URGENT", "tc:cp:U")],
      [button("Cancel", "tc:cx")],
    ] };
  }

  private async choosePriority(externalTelegramId: number, actor: TaskActor, priority: TaskPriority): Promise<TelegramConsoleResponse> {
    const state = this.createState(externalTelegramId, actor.id, "priority");
    if (!state || actor.divisionId === null) return unavailable();
    state.draft.priority = priority; state.step = "owner"; this.touch(state);
    const [divisions, rules] = await Promise.all([this.divisions.findAll({ activeOnly: true }), this.collaborationRules.listRules()]);
    const allowedIds = new Set([actor.divisionId]);
    for (const rule of rules) {
      if (rule.source_division_id === actor.divisionId && rule.task_scope === "ALL" && rule.active && rule.allowed && !rule.requires_approval) {
        allowedIds.add(rule.target_division_id);
      }
    }
    const options = divisions.filter((division) => allowedIds.has(division.id));
    return { text: "Pilih owner Divisi:", inlineKeyboard: [
      ...options.map((division) => [button(division.code, `tc:co:${division.id}`)]),
      [button("Cancel", "tc:cx")],
    ] };
  }

  private async chooseOwner(externalTelegramId: number, actor: TaskActor, ownerDivisionId: number): Promise<TelegramConsoleResponse> {
    const state = this.createState(externalTelegramId, actor.id, "owner");
    if (!state || actor.divisionId === null) return unavailable();
    const [divisions, rules] = await Promise.all([this.divisions.findAll({ activeOnly: true }), this.collaborationRules.listRules()]);
    const same = ownerDivisionId === actor.divisionId;
    const rule = rules.find((item) => item.source_division_id === actor.divisionId && item.target_division_id === ownerDivisionId
      && item.task_scope === "ALL" && item.active && item.allowed);
    if (!same && rule?.requires_approval) {
      return this.safeError(new AppError(409, "TASK_COLLABORATION_APPROVAL_REQUIRED", "Cross-Divisi task collaboration requires approval"));
    }
    const allowed = Boolean(rule && !rule.requires_approval);
    if (!same && !allowed) return this.safeError(new AppError(409, "TASK_CROSS_DIVISION_NOT_ALLOWED", "Cross-Divisi task collaboration is not allowed"));
    if (!divisions.some((division) => division.id === ownerDivisionId)) return unavailable();
    state.draft.ownerDivisionId = ownerDivisionId; state.step = "assignee"; this.touch(state);
    const users = (await this.directory.findActiveByDivision(ownerDivisionId)).filter((user) => user.active && user.roleId !== null && user.divisionId === ownerDivisionId).slice(0, 10);
    return { text: "Pilih assignee:", inlineKeyboard: [
      [button("Unassigned", "tc:ca:0")],
      ...users.map((user) => [button(user.displayName?.trim() || `User #${user.id}`, `tc:ca:${user.id}`)]),
      [button("Cancel", "tc:cx")],
    ] };
  }

  private async chooseAssignee(externalTelegramId: number, actor: TaskActor, assigneeId: number): Promise<TelegramConsoleResponse> {
    const state = this.createState(externalTelegramId, actor.id, "assignee");
    const ownerId = state?.draft.ownerDivisionId;
    if (!state || ownerId === undefined) return unavailable();
    if (assigneeId !== 0) {
      const user = await this.directory.findById(assigneeId);
      if (user && !user.active) return this.safeError(new AppError(400, "TASK_INACTIVE_ASSIGNEE", "Assignee is inactive"));
      if (!user || user.roleId === null || user.divisionId !== ownerId) {
        return this.safeError(new AppError(400, "TASK_INVALID_ASSIGNEE", "Assignee is no longer available"));
      }
    }
    state.draft.assignedToUserId = assigneeId || null; state.step = "deadline"; this.touch(state);
    return { text: "Kirim deadline dengan format YYYY-MM-DD, atau pilih Skip.", inlineKeyboard: [[button("Skip", "tc:cd:s"), button("Cancel", "tc:cx")]] };
  }

  private async skipDeadline(externalTelegramId: number, actor: TaskActor): Promise<TelegramConsoleResponse> {
    const state = this.createState(externalTelegramId, actor.id, "deadline");
    if (!state) return unavailable();
    state.draft.deadline = null; state.step = "review"; this.touch(state);
    return this.review(actor, state);
  }

  private async review(actor: TaskActor, state: CreateState): Promise<TelegramConsoleResponse> {
    if (!state.draft.title || !state.draft.priority || state.draft.ownerDivisionId === undefined || actor.divisionId === null) return unavailable();
    const [divisions, assignee] = await Promise.all([
      this.divisions.findAll(),
      state.draft.assignedToUserId ? this.directory.findById(state.draft.assignedToUserId) : Promise.resolve(null),
    ]);
    const requesting = divisions.find((item) => item.id === actor.divisionId)?.code ?? "Tidak tersedia";
    const owner = divisions.find((item) => item.id === state.draft.ownerDivisionId)?.code ?? "Tidak tersedia";
    return { text: [
      "Create Task · Review", "", `Title: ${state.draft.title}`,
      `Description: ${state.draft.description || "None"}`, `Priority: ${state.draft.priority}`,
      `Requesting Divisi: ${requesting}`, `Owner Divisi: ${owner}`,
      `Assigned To: ${assignee?.displayName?.trim() || "Unassigned"}`,
      `Deadline: ${state.draft.deadline?.slice(0, 10) || "None"}`,
    ].join("\n"), inlineKeyboard: [[button("Confirm Create", "tc:cc")], [button("Cancel", "tc:cx")]] };
  }

  private async confirmCreate(externalTelegramId: number, actor: TaskActor): Promise<TelegramConsoleResponse> {
    const state = this.createState(externalTelegramId, actor.id, "review");
    if (!state || !state.draft.title || !state.draft.priority || state.draft.ownerDivisionId === undefined) return unavailable();
    state.step = "submitting";
    try {
      const task = await this.service.createManual(actor, {
        title: state.draft.title,
        description: state.draft.description,
        priority: state.draft.priority,
        ownerDivisionId: state.draft.ownerDivisionId,
        assignedToUserId: state.draft.assignedToUserId,
        deadline: state.draft.deadline,
      });
      this.states.delete(externalTelegramId);
      return this.taskDetail(actor, task.id, { filter: "o", page: 0 }, "Task berhasil dibuat.");
    } catch (error) {
      state.step = "review"; this.touch(state); throw error;
    }
  }

  private async cancelInput(externalTelegramId: number, actor: TaskActor): Promise<TelegramConsoleResponse> {
    const state = this.currentState(externalTelegramId, actor.id);
    this.states.delete(externalTelegramId);
    if (state?.kind === "comment" || state?.kind === "block") return this.taskDetail(actor, state.taskId, state, "Input dibatalkan.");
    return this.mainMenu(actor, "Input dibatalkan.");
  }

  private createState(externalTelegramId: number, actorId: number, step: CreateStep): CreateState | null {
    const state = this.currentState(externalTelegramId, actorId);
    return state?.kind === "create" && state.step === step ? state : null;
  }

  private currentState(externalTelegramId: number, actorId: number): ConversationState | null {
    const state = this.states.get(externalTelegramId);
    if (!state || state.actorId !== actorId || state.expiresAt <= this.now().getTime()) {
      this.states.delete(externalTelegramId);
      return null;
    }
    return state;
  }

  private touch(state: ConversationState): void { state.expiresAt = this.expiresAt(); }
  private expiresAt(): number { return this.now().getTime() + STATE_TTL_MS; }

  private action(prefix: string, task: Pick<TaskReadModel, "id">, context: NavigationContext): string {
    return `tc:${prefix}:${task.id}:${context.filter}:${context.page}`;
  }

  private taskSummary(task: TaskReadModel): string {
    return `#${task.id} ${task.priority} · ${this.compact(task.title, 50)}${task.is_overdue ? " · OVERDUE" : ""}`;
  }

  private compact(value: string, limit: number): string {
    const clean = value.replace(/[\r\n\t]+/g, " ").trim();
    return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
  }

  private validDate(value: string): boolean {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }

  private safeError(error: unknown, keyboard?: TelegramInlineButton[][]): TelegramConsoleResponse {
    if (!(error instanceof AppError)) return { text: "Permintaan belum dapat diproses. Silakan coba lagi.", inlineKeyboard: keyboard };
    const messages: Readonly<Record<string, string>> = {
      TASK_NOT_FOUND: "Task tidak lagi tersedia.",
      TASK_FORBIDDEN: "Anda tidak memiliki izin untuk task ini.",
      TASK_INVALID_STATUS_TRANSITION: "Status task sudah berubah atau transisi tidak tersedia.",
      TASK_CROSS_DIVISION_NOT_ALLOWED: "Kolaborasi Cross-Divisi tidak tersedia.",
      TASK_COLLABORATION_APPROVAL_REQUIRED: "Kolaborasi ini memerlukan approval dan belum tersedia di Telegram.",
      TASK_INVALID_ASSIGNEE: "Assignee tidak lagi tersedia.",
      TASK_INACTIVE_ASSIGNEE: "Assignee tidak lagi aktif.",
      TASK_INVALID_DEADLINE: "Deadline tidak valid.",
      VALIDATION_ERROR: "Input tidak valid. Periksa kembali data Anda.",
    };
    return { text: messages[error.code] ?? "Permintaan belum dapat diproses. Silakan coba lagi.", inlineKeyboard: keyboard };
  }
}
