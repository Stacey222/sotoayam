import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const historical: Record<string, string> = {
  "202608260001_create_telegram_users.sql": "d634ca351417e6d4093fbf5a0a29cef7ecf4f35c156b28cb8ae93a9d69538eb8",
  "202608270001_add_missing_telegram_users_division.sql": "211485b86385cbbc6ed26490fadfd666aa51974d98f5b829799261b66825360f",
  "202608290001_create_governance_foundation.sql": "abdc8a5193cc4ddcb1d45e945b809900a9f8b07a4a93e242ae9e8752a9eff334",
  "202608290002_create_normalized_identity.sql": "c14d5df487a6be743d6f4e0bef1e2f4616f05434294553106c8355fe2905598d",
  "202608290003_create_it_user_management.sql": "95d224ca99e81093550a7f658a6de68077285f03ea1e06d6576700c7a3e307e7",
  "202608290004_create_task_core.sql": "ee663e8a993452d47cf2d762b9266a588c1e4a873ba2742492f632b6406913c4",
  "202608290005_create_division_collaboration_rules.sql": "ff79f6b3cfa24ab79bf47789dbdf6c6ae40cb2f5fbd9de76ec3ca596e380c31a",
  "202609010001_create_task_ingestion_foundation.sql": "b7ae9e4946ed6f3edb625475928dea4b041fc35e13c2707bf7a49bd6841cbe5b",
  "202609010002_create_task_notification_foundation.sql": "ab0a0fdaff9f392aaa03b94053a0a4077041cbee259b449753051ed147413f76",
  "202609010003_add_task_category.sql": "a62983c817a75a867403a142ecbf0bd34a485fbcbb7e6a710d69b1c942be202c",
  "202609010004_create_critical_alert_foundation.sql": "4d1e81badfd41d9c29337d33e58221fcc60e679ea976a2d9b95a1f77f357a5ca",
  "202609020001_create_business_identity_and_integration_capabilities.sql": "d6d9c372ca7793134356257fd0d7eaaee34cb4262ff1b6909983b2692f847cb2",
  "202609080001_create_notification_event_intake.sql": "3a97415a0460d4aa2b28c186f85949dceb0cba5af367d1e34e8d0f2826a2fa76",
  "202609090001_create_first_admin_bootstrap.sql": "09e43d6ac26e1fb89f0d3da0648ff7878f323b2a18f65d8e8d7c76754784b6a0",
};

const migrationPath = path.resolve("supabase/migrations/202609090002_implement_customer_taxonomy_transition.sql");

describe("P0-14 migration integrity", () => {
  it("keeps all fourteen historical migration bytes unchanged", async () => {
    for (const [name, expected] of Object.entries(historical)) {
      const bytes = await readFile(path.resolve("supabase/migrations", name));
      expect(createHash("sha256").update(bytes).digest("hex"), name).toBe(expected);
    }
  });

  it("adds exactly the approved next migration", async () => {
    const names = (await readdir(path.resolve("supabase/migrations"))).filter((name) => name.endsWith(".sql")).sort();
    expect(names.at(-1)).toBe("202609090002_implement_customer_taxonomy_transition.sql");
    expect(names).toHaveLength(15);
  });

  it("does not execute destructive operational DML during migration", async () => {
    const sql = await readFile(migrationPath, "utf8");
    const functionStart = sql.indexOf("create or replace function public.provision_first_installation");
    const bodyStart = sql.indexOf("as $$", functionStart);
    const bodyEnd = sql.indexOf("\n$$;", bodyStart);
    const withoutFunctionBodies = sql.replace(/as \$\$[\s\S]*?\n\$\$;/g, "as $$\n[function body]\n$$;");
    expect(withoutFunctionBodies).not.toMatch(/delete\s+from\s+public\.(?:divisions|division_collaboration_rules)/i);
    expect(sql.slice(bodyStart, bodyEnd)).toMatch(/delete\s+from\s+public\.division_collaboration_rules/i);
    expect(sql.slice(bodyStart, bodyEnd)).toMatch(/delete\s+from\s+public\.divisions/i);
  });

  it("keeps the old bootstrap signature singular and does not introduce ADMINISTRATION", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql.match(/create or replace function public\.bootstrap_first_admin\s*\(/g)).toHaveLength(1);
    const declaration = sql.slice(
      sql.indexOf("create or replace function public.bootstrap_first_admin"),
      sql.indexOf("returns table", sql.indexOf("create or replace function public.bootstrap_first_admin")),
    ).replace(/\s+/g, " ");
    expect(declaration).toContain("( p_display_name text, p_email text, p_password_algorithm text, p_password_hash text )");
    expect(sql).not.toContain("ADMINISTRATION");
  });
});
