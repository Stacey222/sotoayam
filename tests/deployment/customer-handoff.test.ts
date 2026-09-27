import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const read = (file: string) => readFile(path.join(root, file), "utf8");

describe("customer release handoff", () => {
  it("defines one consistent customer release identity", async () => {
    const manifest = JSON.parse(await read("package.json")) as { version: string; engines: { node: string } };
    const lock = JSON.parse(await read("package-lock.json")) as {
      version: string; packages: Record<string, { version?: string }>;
    };
    const migrations = (await readdir(path.join(root, "supabase/migrations"))).filter((name) => name.endsWith(".sql"));
    const notes = await read("docs/customer-release-notes-v1.0.0.md");

    expect(manifest.version).toBe("1.0.0");
    expect(lock.version).toBe(manifest.version);
    expect(lock.packages[""]?.version).toBe(manifest.version);
    expect(manifest.engines.node).toBe((await read(".node-version")).trim());
    expect(migrations).toHaveLength(25);
    expect(notes).toContain("sotoayam-v1.0.0-<12-karakter-git-sha>.tar.gz");
  });

  it("documents the customer capabilities, V1 boundaries, and support responsibilities", async () => {
    const notes = await read("docs/customer-release-notes-v1.0.0.md");
    const guide = await read("docs/customer-operator-guide.md");
    for (const expected of ["alur tugas", "pengelolaan pengguna", "bootstrap", "Telegram", "backup",
      "`/health`", "`/ready`", "Satu instance", "multi-tenancy", "Linux VPS", "Hard delete"]) {
      expect(notes).toContain(expected);
    }
    for (const expected of ["## 1. Login", "## 2. Pengguna", "## 3. Tugas", "## 4. Perubahan status",
      "## 5. Pengaturan", "## 6. Pairing Telegram", "## 7. Preferensi notifikasi",
      "## 8. Notifikasi uji", "## 9. Health dan readiness", "## 10. Backup", "## 11. Restore",
      "## 12. Restart service", "## 13. Log", "## 14. Bila Telegram berhenti",
      "## 15. Yang tidak boleh diubah manual", "## Batas dukungan"]) {
      expect(guide).toContain(expected);
    }
    expect(guide).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO|FROM|public\.)|\bALTER\s+TABLE\b/i);
  });

  it("provides an executable PASS/FAIL acceptance and founder-independent handoff sequence", async () => {
    const checklist = await read("docs/customer-acceptance-checklist.md");
    const runbook = await read("docs/customer-handoff-runbook.md");
    const onboarding = await read("docs/customer-onboarding.md");
    expect(checklist.match(/PASS\/FAIL/g)?.length).toBeGreaterThanOrEqual(1);
    for (const expected of ["25 migrasi", "`/setup`", "OWNER", "notifikasi uji", "Tugas uji",
      "`GET /health`", "`GET /ready`", "`npm run backup:create`", "`npm run backup:verify`", "restore"]) {
      expect(checklist).toContain(expected);
    }
    for (const expected of ["menyerahkan arsip", "menjalankan migrasi", "membuka `/setup`",
      "pairing Telegram", "Checklist Penerimaan", "`backup:create`", "ditandatangani secara operasional"]) {
      expect(runbook).toContain(expected);
    }
    expect(runbook).not.toMatch(/Kento|owner@sotoayam\.local/i);
    expect(onboarding).toContain("Customer tidak perlu mengetahui chat ID Telegram");
  });

  it("keeps customer package inputs free from origin identities and legacy deployment branding", async () => {
    const packaging = await read("scripts/deploy/package-release.ps1");
    const archiveCommand = packaging.match(/^\s*tar -czf \$partial (.+)$/m)?.[1] ?? "";
    const archiveEntries = archiveCommand.split(/\s+/);
    const customerTextEntries = archiveEntries.filter((entry) =>
      entry === "package.json" || entry === ".env.example" || entry.endsWith(".md") || entry.endsWith(".sh"),
    );
    const customerText = (await Promise.all(customerTextEntries.map(read))).join("\n");

    expect(customerText).not.toMatch(/Kento|owner@sotoayam\.local/i);
    expect(customerText).not.toMatch(/gwens-automation|\/opt\/gwens|SERVICE_NAME="gwens/i);
    expect(customerText).not.toContain("dev:prepare-owner");
  });
});
