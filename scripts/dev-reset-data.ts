import { readFile } from "node:fs/promises";
import { runDevelopmentSql } from "./dev-database-command.js";

async function main(): Promise<void> {
  const sql = await readFile(new URL("./sql/dev-reset-data.sql", import.meta.url), "utf8");
  await runDevelopmentSql(sql, "SOTOAYAM_DEV_RESET_CONFIRMATION",
    "RESET_SOTOAYAM_DEVELOPMENT_DATA");
  console.log("DEVELOPMENT_RESET = PASS");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Development reset refused");
  process.exitCode = 1;
});
