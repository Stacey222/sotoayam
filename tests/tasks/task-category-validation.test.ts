import { describe, expect, it, vi } from "vitest";
import type { TaskCategoryCatalogEntry } from "../../src/governance/types.js";
import type { TaskCategoriesRepository } from "../../src/repositories/task-categories.repository.js";
import { TaskCategoryService } from "../../src/services/task-category.service.js";

const row = (code: string, active = true): TaskCategoryCatalogEntry => ({
  id: code.length, code, name: code, active, created_at: "now", updated_at: "now",
});

class Categories implements TaskCategoriesRepository {
  rows: TaskCategoryCatalogEntry[] = [];
  reads = 0;
  async findAll() { this.reads++; return this.rows; }
  async create(input: { code: string; name: string }) { const value = { ...row(input.code), name: input.name }; this.rows.push(value); return value; }
  async update(id: number, input: { name?: string; active?: boolean }) { const value = this.rows.find((item) => item.id === id)!; Object.assign(value, input); return value; }
  async delete(id: number) { const index = this.rows.findIndex((item) => item.id === id); return this.rows.splice(index, 1)[0]!; }
}

describe("P0-14 task category catalog validation", () => {
  it("allows null and rejects every non-null value when the catalog is empty", async () => {
    const service = new TaskCategoryService(new Categories());
    await expect(service.validate(null)).resolves.toBeNull();
    await expect(service.validate("AFFILIATE")).rejects.toMatchObject({ code: "TASK_INVALID_CATEGORY" });
  });

  it("accepts arbitrary active catalog codes and normalizes input", async () => {
    const repository = new Categories(); repository.rows = [row("FULFILLMENT")];
    await expect(new TaskCategoryService(repository).validate(" fulfillment ")).resolves.toBe("FULFILLMENT");
  });

  it("rejects inactive and unknown categories for new assignments", async () => {
    const repository = new Categories(); repository.rows = [row("AFFILIATE", false), row("FULFILLMENT")];
    const service = new TaskCategoryService(repository);
    await expect(service.validate("AFFILIATE")).rejects.toMatchObject({ code: "TASK_INVALID_CATEGORY" });
    await expect(service.validate("UNKNOWN")).rejects.toMatchObject({ code: "TASK_INVALID_CATEGORY" });
  });

  it("uses a bounded cache and invalidates it after every mutation", async () => {
    const repository = new Categories(); repository.rows = [row("FULFILLMENT")];
    const service = new TaskCategoryService(repository, 1_000, () => 100);
    await service.validate("FULFILLMENT"); await service.validate("FULFILLMENT");
    expect(repository.reads).toBe(1);
    await service.create({ code: "SALES_ORDER", name: "Sales order" }, 1);
    await expect(service.validate("SALES_ORDER")).resolves.toBe("SALES_ORDER");
    expect(repository.reads).toBe(2);
  });

  it("fails closed when the catalog repository fails", async () => {
    const repository = new Categories(); vi.spyOn(repository, "findAll").mockRejectedValue(new Error("database unavailable"));
    await expect(new TaskCategoryService(repository).validate("FULFILLMENT")).rejects.toThrow("database unavailable");
  });
});

