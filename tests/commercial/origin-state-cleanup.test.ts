import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function repositoryFile(file: string): Promise<string> {
  return readFile(path.resolve(file), "utf8");
}

describe("P0-15 customer-facing cleanup", () => {
  it("documents the ordered migration and mandatory admin-key contracts without origin product examples", async () => {
    const readme = await repositoryFile("README.md");

    expect(readme).toContain("npm run migrate");
    expect(readme).toMatch(/ADMIN_API_KEY[^\n]*minimal 32 karakter/);
    expect(readme).not.toMatch(/ADMIN_API_KEY[^\n]*(?:opsional|API admin bersifat public)/i);
    expect(readme).not.toMatch(/Squishy|Strawberry/i);
  });

  it("uses only the real Telegram polling variable in agent instructions", async () => {
    const instructions = await repositoryFile("AGENTS.md");

    expect(instructions).not.toMatch(/(?:LOCAL|VPS)_GWENS_POLLING/);
    expect(instructions).toContain("TELEGRAM_POLLING_ENABLED=false");
    expect(instructions).toContain("TELEGRAM_POLLING_ENABLED=true");
  });

  it("keeps intentional compatibility identifiers at their established boundaries", async () => {
    const browser = await repositoryFile("public/app.js");
    const deployment = await repositoryFile("scripts/deploy/deployment-config.sh");
    const contract = await repositoryFile("tests/fixtures/legacy-schema-contract.json");
    const bootstrap = await repositoryFile("supabase/migrations/202609090001_create_first_admin_bootstrap.sql");

    expect(browser).not.toContain('"gwens-admin-key"');
    expect(browser).not.toContain("sessionStorage");
    expect(browser).toContain('"/api/admin/auth/session"');
    expect(deployment).toContain('SOTOAYAM_DEFAULT_APP_ROOT="/opt/sotoayam"');
    expect(contract).toContain('"GWENS_LEGACY_SCHEMA_V1"');
    expect(bootstrap).toContain("gwens_system_admin_invariant");
  });
});
