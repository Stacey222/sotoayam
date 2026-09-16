import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const MESSAGE_CATALOG_CALL_SITES = [
  "src/telegram/bot.ts",
  "src/telegram/task-console.ts",
  "src/telegram/it-console.ts",
  "src/telegram/owner-console.ts",
  "src/services/reminder-evaluator.service.ts",
  "public/ui-core.js",
  "public/app.js",
  "public/users.js",
  "public/settings.js",
] as const;

// Deliberately bounded to stable, catalog-owned presentation text. Protocol identifiers,
// callback_data, SQL, enums, tests, and static index.html markup are outside this check.
export const CATALOG_OWNED_LITERALS = [
  "Perintah tidak tersedia.",
  "Permintaan belum dapat diproses. Silakan coba lagi.",
  "Sotoayam Task Console",
  "Sotoayam IT Console",
  "Sotoayam Owner Console",
  "Pengingat tugas",
  "Eskalasi tugas",
  "Tidak dapat terhubung ke Sotoayam.",
  "Email atau kata sandi tidak valid.",
  "Sesi Anda telah berakhir. Silakan masuk kembali.",
  "Belum ada pengguna untuk filter ini.",
  "Pengaturan runtime berhasil diterapkan.",
] as const;

export function catalogLiteralViolations(files: Readonly<Record<string, string>>,
  literals: readonly string[] = CATALOG_OWNED_LITERALS): string[] {
  const violations: string[] = [];
  for (const [file, source] of Object.entries(files)) {
    for (const literal of literals) if (source.includes(literal)) violations.push(`${file}: ${JSON.stringify(literal)}`);
  }
  return violations;
}

export async function checkMessageCatalog(): Promise<void> {
  const files = Object.fromEntries(await Promise.all(MESSAGE_CATALOG_CALL_SITES.map(async (file) =>
    [file, await readFile(file, "utf8")] as const)));
  const violations = catalogLiteralViolations(files);
  if (violations.length) throw new Error(`Catalog-owned literals found outside catalogs:\n${violations.join("\n")}`);
  console.log(`MESSAGE_CATALOG_SCOPE = ${MESSAGE_CATALOG_CALL_SITES.length} call sites`);
  console.log(`MESSAGE_CATALOG_LITERALS = ${CATALOG_OWNED_LITERALS.length}`);
  console.log("MESSAGE_CATALOG = PASS");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkMessageCatalog().catch((error) => { console.error(`MESSAGE_CATALOG = FAIL: ${error instanceof Error ? error.message : "Unknown error"}`); process.exitCode = 1; });
}
