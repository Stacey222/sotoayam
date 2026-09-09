import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migration = path.resolve("supabase/migrations/202609090002_implement_customer_taxonomy_transition.sql");

describe("P0-14 old-application/new-schema compatibility", () => {
  it("V: keeps bootstrap_first_admin singular with the exact historical parameter list", async () => {
    const sql = await readFile(migration, "utf8");
    const historical = await readFile(path.resolve("supabase/migrations/202609090001_create_first_admin_bootstrap.sql"), "utf8");
    expect(sql.match(/create or replace function public\.bootstrap_first_admin\s*\(/g)).toHaveLength(1);
    expect(historical).toContain("revoke all on function public.bootstrap_first_admin(text, text, text, text)");
    expect(historical).toContain("grant execute on function public.bootstrap_first_admin(text, text, text, text) to service_role");
    expect(sql).toContain("create or replace function public.provision_first_installation(");
  });

  it("uses capability in runtime authorization while retaining only named compatibility adapters", async () => {
    const files = [
      "src/repositories/users.repository.ts",
      "src/routes/admin-user-management.routes.ts",
      "src/routes/admin-notifications.routes.ts",
      "src/routes/critical-alerts.routes.ts",
      "src/services/integration-administration.service.ts",
      "src/services/collaboration-rule-management.service.ts",
      "src/telegram/it-console.ts",
    ];
    for (const file of files) {
      const source = await readFile(path.resolve(file), "utf8");
      expect(source, file).not.toMatch(/division(?:Code|\.code)\s*!==?\s*["']IT["']/);
    }
    const sql = await readFile(migration, "utf8");
    expect(sql.match(/where code = 'IT';/g)).toHaveLength(1);
    expect(sql).toContain("comment on function public.assert_it_system_admin(bigint)");
  });

  it("keeps legacy display mapping as fallback after normalized catalog names", async () => {
    const sql = await readFile(migration, "utf8");
    expect(sql).toContain("coalesce(division_row.name, public.legacy_division_value(target_division_code), 'UNASSIGNED')");
    expect(sql).toContain("coalesce(role_row.name, public.legacy_role_value(target_role_code), 'UNASSIGNED')");
    expect(sql).toContain("if existing_user.legacy_telegram_user_id is not null then");
  });
});
