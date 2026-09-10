import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migration = path.resolve("supabase/migrations/202609110001_create_integration_credentials.sql");

describe("P1-04 additive migration contract", () => {
  it("P4-29 adds exactly one seventeenth migration with only additive top-level operations", async () => {
    const names = (await readdir(path.resolve("supabase/migrations"))).filter((name) => name.endsWith(".sql")).sort();
    expect(names).toHaveLength(18); expect(names.at(-2)).toBe("202609110001_create_integration_credentials.sql");
    const sql = await readFile(migration, "utf8");
    const topLevel = sql.replace(/as \$\$[\s\S]*?\n\$\$;/g, "as $$\n[function body]\n$$;");
    expect(topLevel).not.toMatch(/\b(drop|truncate|delete\s+from)\b/i);
    expect(sql).toContain("create table public.integration_credentials");
    expect(sql).toContain("add column integration_id bigint references public.task_source_integrations (id)");
  });

  it("defines RPC-only credential access without returning secret hashes", async () => {
    const sql = await readFile(migration, "utf8");
    expect(sql).toContain("revoke all on table public.integration_credentials from public, anon, authenticated, service_role");
    for (const name of ["authenticate_integration_credential", "create_integration_credential",
      "revoke_integration_credential", "revoke_integration_credentials_for_integration", "list_integration_credentials"] ) {
      expect(sql).toContain(`function public.${name}`);
    }
    const listDeclaration = sql.slice(sql.indexOf("create or replace function public.list_integration_credentials"),
      sql.indexOf("language plpgsql", sql.indexOf("create or replace function public.list_integration_credentials")));
    expect(listDeclaration).not.toContain("secret_hash");
  });

  it("P4-31 preserves the historical intake bytes and uses a distinctly named attributed RPC", async () => {
    const historical = await readFile(path.resolve("supabase/migrations/202609080001_create_notification_event_intake.sql"));
    expect(createHash("sha256").update(historical).digest("hex"))
      .toBe("3a97415a0460d4aa2b28c186f85949dceb0cba5af367d1e34e8d0f2826a2fa76");
    const sql = await readFile(migration, "utf8");
    expect(sql).toContain("create or replace function public.intake_attributed_notification_event");
    expect(sql).not.toContain("create or replace function public.intake_notification_event(");
    expect(sql).toContain("source, external_event_id, identity_origin, event_type, payload_hash, message, integration_id");
  });
});
