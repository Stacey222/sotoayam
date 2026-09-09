import { AppError, DatabaseError } from "../errors.js";
import type { TaskCategoryCatalogEntry } from "../governance/types.js";
import type { TaskCategoriesRepository } from "../repositories/task-categories.repository.js";

export interface TaskCategoryValidator {
  validate(value: string | null | undefined): Promise<string | null>;
}

export class TaskCategoryService implements TaskCategoryValidator {
  private cache: { expiresAt: number; active: ReadonlySet<string> } | null = null;

  constructor(
    private readonly repository: TaskCategoriesRepository,
    private readonly cacheTtlMs = 30_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  list(): Promise<TaskCategoryCatalogEntry[]> { return this.repository.findAll(); }

  async validate(value: string | null | undefined): Promise<string | null> {
    if (value === undefined || value === null || value.trim() === "") return null;
    const code = value.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{0,49}$/.test(code)) this.invalid();
    const active = await this.activeCodes();
    if (active.size === 0 || !active.has(code)) this.invalid();
    return code;
  }

  async create(input: { code: string; name: string }, actorUserId: number) {
    const code = input.code.trim().toUpperCase();
    const name = this.name(input.name);
    if (!/^[A-Z][A-Z0-9_]{0,49}$/.test(code)) this.invalid();
    let result: TaskCategoryCatalogEntry;
    try { result = await this.repository.create({ code, name, actorUserId }); }
    catch (error) { throw this.map(error); }
    this.invalidate();
    return result;
  }

  async update(id: number, input: { name?: string; active?: boolean }, actorUserId: number) {
    let result: TaskCategoryCatalogEntry;
    try { result = await this.repository.update(id, {
        ...(input.name === undefined ? {} : { name: this.name(input.name) }),
        ...(input.active === undefined ? {} : { active: input.active }), actorUserId,
      }); }
    catch (error) { throw this.map(error); }
    this.invalidate();
    return result;
  }

  async delete(id: number, actorUserId: number) {
    let result: TaskCategoryCatalogEntry;
    try { result = await this.repository.delete(id, actorUserId); }
    catch (error) { throw this.map(error); }
    this.invalidate();
    return result;
  }

  private async activeCodes(): Promise<ReadonlySet<string>> {
    if (this.cache && this.cache.expiresAt > this.now()) return this.cache.active;
    const rows = await this.repository.findAll();
    const active = new Set(rows.filter((row) => row.active).map((row) => row.code));
    this.cache = { active, expiresAt: this.now() + this.cacheTtlMs };
    return active;
  }

  private invalidate(): void { this.cache = null; }
  private invalid(): never { throw new AppError(400, "TASK_INVALID_CATEGORY", "Task category is not active in the catalog"); }
  private name(value: string): string {
    const name = value.trim();
    if (!name || name.length > 120) throw new AppError(400, "VALIDATION_ERROR", "Task category name must contain 1-120 characters");
    return name;
  }
  private map(error: unknown): Error {
    if (!(error instanceof DatabaseError)) return error instanceof Error ? error : new Error("Task category mutation failed");
    const message = error.diagnostic.message ?? "";
    if (message.includes("TASK_CATEGORY_IN_USE")) return new AppError(409, "TASK_CATEGORY_IN_USE", "Task category is used by historical tasks; deactivate it instead");
    if (message.includes("TASK_CATEGORY_NOT_FOUND")) return new AppError(404, "TASK_CATEGORY_NOT_FOUND", "Task category not found");
    if (message.includes("TASK_CATEGORY_DUPLICATE_CODE")) return new AppError(409, "TASK_CATEGORY_DUPLICATE_CODE", "Task category code already exists");
    return error;
  }
}
