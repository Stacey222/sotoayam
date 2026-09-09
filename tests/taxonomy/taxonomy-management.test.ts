import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import { hasSystemAdminCapability } from "../../src/auth/system-admin-capability.js";
import { AppError } from "../../src/errors.js";
import type { AdminDivision, ManagedRole } from "../../src/governance/types.js";
import type { DivisionsRepository } from "../../src/repositories/divisions.repository.js";
import type { RolesRepository } from "../../src/repositories/roles.repository.js";
import { TaxonomyManagementService } from "../../src/services/taxonomy-management.service.js";
import { TaskCategoryService } from "../../src/services/task-category.service.js";
import { taxonomyRoutes } from "../../src/routes/taxonomy.routes.js";
import type { TaskActor } from "../../src/tasks/types.js";

const actor = (overrides: Partial<TaskActor> = {}): TaskActor => ({
  id: 1, active: true, divisionId: 10, divisionCode: "OPERATIONS", divisionGrantsSystemAuthority: true,
  roleId: 2, roleCode: "ADMIN", permissions: new Set(), ...overrides,
});

const division = (overrides: Partial<AdminDivision> = {}): AdminDivision => ({
  id: 10, code: "OPERATIONS", name: "Operations", active: true, grants_system_authority: true,
  provisioning_source: "SETUP", created_at: "now", updated_at: "now", ...overrides,
});

function harness() {
  const rows = [division()];
  const createManaged = vi.fn(async (input: { code: string; name: string }) => {
    const value = division({ id: rows.length + 10, code: input.code, name: input.name,
      grants_system_authority: false, provisioning_source: "CUSTOMER" });
    rows.push(value); return value;
  });
  const divisions = {
    findAll: async () => rows, findByCode: async (code: string) => rows.find((item) => item.code === code) ?? null,
    create: vi.fn(), findAdminCatalog: async () => rows, createManaged,
    updateManaged: vi.fn(), deleteManaged: vi.fn(),
  } as unknown as DivisionsRepository;
  const managedRoles: ManagedRole[] = [{ id: 2, code: "ADMIN", name: "Admin", active: true,
    system_managed: true, created_at: "now", updated_at: "now" }];
  const roles = { findAll: async () => managedRoles, findByCode: async () => managedRoles[0]!,
    findManaged: async () => managedRoles, rename: vi.fn() } as unknown as RolesRepository;
  return { service: new TaxonomyManagementService(divisions, roles), createManaged, rows };
}

describe("P0-14 taxonomy management", () => {
  it("uses capability rather than a literal division name", () => {
    expect(hasSystemAdminCapability(actor({ divisionCode: "CUSTOMER_ADMIN" }))).toBe(true);
    expect(hasSystemAdminCapability(actor({ divisionCode: "IT", divisionGrantsSystemAuthority: false }))).toBe(false);
    expect(hasSystemAdminCapability(actor({ divisionGrantsSystemAuthority: undefined }))).toBe(false);
  });

  it("creates customer divisions with capability forced false, including code IT", async () => {
    const test = harness();
    const created = await test.service.createDivision({ code: "it", name: "Customer IT" }, actor());
    expect(created).toMatchObject({ code: "IT", grants_system_authority: false, provisioning_source: "CUSTOMER" });
    expect(test.createManaged).toHaveBeenCalledWith(expect.objectContaining({ code: "IT" }));
  });

  it("denies a named IT actor without the capability", async () => {
    await expect(harness().service.createDivision({ code: "SALES", name: "Sales" },
      actor({ divisionCode: "IT", divisionGrantsSystemAuthority: false }))).rejects.toMatchObject({ code: "TAXONOMY_FORBIDDEN" });
  });

  it("does not put capability on the broad shared Division type", async () => {
    const source = await readFile("src/governance/types.ts", "utf8");
    expect(source).toMatch(/export interface Division extends GovernanceCatalogEntry \{\}/);
    expect(source).toMatch(/export interface AdminDivision extends Division \{\s+grants_system_authority: boolean;/);
  });

  it("rejects immutable and privileged fields at the HTTP boundary", async () => {
    const test = harness();
    const categories = { findAll: async () => [], create: vi.fn(), update: vi.fn(), delete: vi.fn() };
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => {
      const appError = error instanceof AppError ? error : new AppError(500, "INTERNAL_ERROR", "Unexpected error");
      return reply.status(appError.statusCode).send({ error: { code: appError.code, message: appError.message } });
    });
    await app.register(taxonomyRoutes, { service: test.service,
      categories: new TaskCategoryService(categories), actorResolver: { resolveTrustedActor: async () => actor() }, adminApiKey: "key" });
    const headers = { "x-admin-api-key": "key", "content-type": "application/json" };
    expect((await app.inject({ method: "PATCH", url: "/divisions/10", headers,
      payload: { code: "CHANGED" } })).json().error.code).toBe("DIVISION_CODE_IMMUTABLE");
    expect((await app.inject({ method: "PATCH", url: "/divisions/10", headers,
      payload: { grants_system_authority: true } })).json().error.code).toBe("VALIDATION_ERROR");
    expect((await app.inject({ method: "PATCH", url: "/roles/2", headers,
      payload: { code: "CUSTOM" } })).json().error.code).toBe("ROLE_RESERVED");
    expect((await app.inject({ method: "PATCH", url: "/task-categories/1", headers,
      payload: { code: "CHANGED" } })).json().error.code).toBe("TASK_CATEGORY_CODE_IMMUTABLE");
    await app.close();
  });

  it("ships a data-only preset sample conforming to the declared schema contract", async () => {
    const schema = JSON.parse(await readFile("presets/preset.schema.json", "utf8")) as Record<string, unknown>;
    const preset = JSON.parse(await readFile("presets/warehouse-b2b-b2c/1.0.0.json", "utf8")) as {
      schema_version: string; preset_code: string; name: string;
      divisions: Array<{ code: string; name: string }>;
      task_categories: Array<{ code: string; name: string }>;
      collaboration_rules: Array<{ source_division: string; target_division: string; task_scope: string; allowed: boolean; requires_approval: boolean }>;
    };
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(preset.schema_version).toBe("1.0.0");
    expect(preset.preset_code).toMatch(/^[A-Z][A-Z0-9_]{0,99}$/);
    expect(preset.divisions.every((item) => /^[A-Z][A-Z0-9_]{0,99}$/.test(item.code) && item.name.length > 0)).toBe(true);
    expect(preset.task_categories.every((item) => /^[A-Z][A-Z0-9_]{0,49}$/.test(item.code) && item.name.length > 0)).toBe(true);
    const divisions = new Set(preset.divisions.map((item) => item.code));
    expect(preset.collaboration_rules.every((rule) => divisions.has(rule.source_division)
      && divisions.has(rule.target_division) && rule.source_division !== rule.target_division
      && rule.task_scope === "ALL" && (!rule.requires_approval || rule.allowed))).toBe(true);
  });
});
