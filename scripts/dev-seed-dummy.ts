import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { hashPassword } from "../src/auth/admin-password.js";
import { runDevelopmentSql } from "./dev-database-command.js";

async function main(): Promise<void> {
  const template = await readFile(new URL("./sql/dev-seed-dummy.sql", import.meta.url), "utf8");
  const userHash = await hashPassword(randomBytes(32));
  const adminHash = await hashPassword(randomBytes(32));
  for (const hash of [userHash, adminHash]) {
    if (!/^scrypt\$N=32768,r=8,p=1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(hash)) {
      throw new Error("Generated dummy credential has unexpected format");
    }
  }
  const sql = template.replace("__DUMMY_USER_HASH__", userHash)
    .replace("__DUMMY_ADMIN_HASH__", adminHash);
  await runDevelopmentSql(sql, "SOTOAYAM_DEV_SEED_CONFIRMATION",
    "SEED_SOTOAYAM_DUMMY_DATA");
  console.log("DEVELOPMENT_DUMMY_SEED = PASS");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Dummy seed refused");
  process.exitCode = 1;
});
