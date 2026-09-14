import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertDisposableIdentity, buildMigrationManifest } from "../../scripts/check-clean-migrations.js";

describe("P1-09 clean migration harness", () => {
  it("discovers the complete ordered 20-migration schema manifest", async () => {
    const manifest = await buildMigrationManifest(path.resolve("supabase/migrations"));
    expect(manifest.migrations).toHaveLength(20);
    expect(manifest.migrations[0]).toBe("202608260001_create_telegram_users.sql");
    expect(manifest.migrations.at(-1)).toBe("202609140001_create_admin_user_management.sql");
    expect(manifest.tables).toHaveLength(33);
    expect(manifest.tables).toContain("telegram_polling_state");
    expect(manifest.functions).toContain("load_telegram_polling_state");
    expect(manifest.requiredExtensions).toEqual([]);
    expect(manifest.serviceRoleRpcs).toContain("load_telegram_polling_state()");
    expect(manifest.serviceRoleRpcs).toContain("validate_admin_session(text, integer, integer)");
    expect(manifest.serviceRoleRpcs).toContain("intake_attributed_notification_event(text, text, text, text, text, text, jsonb, bigint)");
  });

  it("accepts only the exact isolated loopback cluster identity", () => {
    const expectedDirectory = path.resolve("temporary", "postgres-data");
    expect(() => assertDisposableIdentity({
      address: "127.0.0.1/32",
      port: 55432,
      database: "postgres",
      dataDirectory: expectedDirectory,
      version: "17.6",
    }, 55432, expectedDirectory)).not.toThrow();
  });

  it.each([
    ["remote address", { address: "10.0.0.10", port: 55432, database: "postgres" }],
    ["wrong port", { address: "127.0.0.1", port: 5432, database: "postgres" }],
    ["wrong database", { address: "127.0.0.1", port: 55432, database: "development" }],
  ])("fails closed for %s", (_label, identity) => {
    const expectedDirectory = path.resolve("temporary", "postgres-data");
    expect(() => assertDisposableIdentity({
      ...identity,
      dataDirectory: expectedDirectory,
      version: "17.6",
    }, 55432, expectedDirectory)).toThrow();
  });

  it("fails closed for a different PostgreSQL data directory", () => {
    expect(() => assertDisposableIdentity({
      address: "127.0.0.1",
      port: 55432,
      database: "postgres",
      dataDirectory: path.resolve("unexpected", "postgres-data"),
      version: "17.6",
    }, 55432, path.resolve("temporary", "postgres-data"))).toThrow(
      "Target data directory does not match the isolated cluster",
    );
  });
});
