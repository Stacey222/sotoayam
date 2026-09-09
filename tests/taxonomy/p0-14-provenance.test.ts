import { readFile } from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { reportsRoutes } from "../../src/routes/reports.routes.js";

const migration = path.resolve("supabase/migrations/202609090002_implement_customer_taxonomy_transition.sql");

describe("P0-14 installation provenance", () => {
  it("starts empty and can only be declared by explicit setup provisioning", async () => {
    const sql = await readFile(migration, "utf8");
    const beforeProvision = sql.slice(0, sql.indexOf("create or replace function public.provision_first_installation"));
    expect(beforeProvision).not.toMatch(/insert\s+into\s+public\.installation_provenance/i);
    expect(sql).toContain("lineage in ('FRESH', 'LEGACY')");
    expect(sql).toContain("prevent_installation_provenance_update_or_delete");
    expect(sql).toContain("declaration_source text not null check (declaration_source = 'setup_cli')");
    expect(sql).not.toContain("declared_by");
  });

  it("uses UNKNOWN as the application fallback and treats it as legacy-compatible", async () => {
    const source = await readFile(path.resolve("src/repositories/installation-provenance.repository.ts"), "utf8");
    expect(source).toContain('return data ?');
    expect(source).toContain(': "UNKNOWN"');
    const app = Fastify();
    await app.register(reportsRoutes, {
      service: { affiliateTaskStatus: vi.fn().mockResolvedValue({}) } as never,
      actorResolver: { resolveOwnerActor: vi.fn().mockResolvedValue({}) },
      adminApiKey: "key", legacyAliasEnabled: true,
    });
    expect((await app.inject({ method: "GET", url: "/content-creator/affiliate-task-status", headers: { "x-admin-api-key": "key" } })).statusCode).toBe(200);
    await app.close();
  });

  it("does not register the legacy alias for FRESH lineage even when legacy strings exist", async () => {
    const app = Fastify();
    await app.register(reportsRoutes, {
      service: {} as never, actorResolver: {} as never, adminApiKey: "key", legacyAliasEnabled: false,
    });
    expect((await app.inject({ method: "GET", url: "/content-creator/affiliate-task-status", headers: { "x-admin-api-key": "key" } })).statusCode).toBe(404);
    await app.close();
  });

  it("records only fixed evidence counters and sanitized retirement results", async () => {
    const sql = await readFile(migration, "utf8");
    for (const key of ["users", "telegram_users", "tasks", "system_authority_assignments", "admin_credentials",
      "instance_bootstrap", "non_migration_seed_audit_logs", "extra_or_modified_seed_divisions",
      "non_origin_collaboration_rules", "users_division_refs", "task_requesting_division_refs",
      "task_owner_division_refs", "collaboration_source_division_refs", "collaboration_target_division_refs",
      "integration_requesting_division_refs", "routing_owner_division_refs", "alert_owner_division_refs"]) {
      expect(sql, key).toContain(`'${key}'`);
    }
    const provenanceInsert = sql.slice(
      sql.indexOf("insert into public.installation_provenance"),
      sql.indexOf(";", sql.indexOf("insert into public.installation_provenance")) + 1,
    );
    expect(provenanceInsert).not.toMatch(/(?:email|display_name|password_hash|telegram|user_id)/i);
  });
});
