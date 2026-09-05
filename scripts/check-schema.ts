import { readFile } from "node:fs/promises";
import path from "node:path";
import "dotenv/config";
import { loadSupabaseConfig } from "../src/config/env.js";
import { createSupabaseClient } from "../src/db/supabase.js";

interface SchemaFixture {
  table: string;
  columns: Array<{ name: string }>;
  constraints: Array<{ kind: string; columns: string[]; live_status: string }>;
  indexes: Array<{ name: string; live_status: string }>;
  rls: { live_status: string };
  trigger: { name: string; live_status: string };
}

function sanitize(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let safe = value;
  for (const secret of [
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.TELEGRAM_BOT_TOKEN,
  ]) {
    if (secret) safe = safe.replaceAll(secret, "[REDACTED]");
  }
  return safe
    .replace(/https?:\/\/\S+/gi, "[REDACTED_URL]")
    .replace(/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, "[REDACTED_KEY]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED_JWT]")
    .slice(0, 300);
}

async function main(): Promise<void> {
  console.log("Sotoayam Legacy Schema Compatibility\n");
  const fixturePath = path.resolve(process.cwd(), "tests/fixtures/legacy-schema-contract.json");
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as SchemaFixture;
  const client = createSupabaseClient(loadSupabaseConfig());

  const table = await client.from(fixture.table).select("id", { head: true }).limit(1);
  const tablePass = !table.error;
  console.log(`TELEGRAM_USERS_TABLE = ${tablePass ? "PASS" : "FAIL"}`);
  if (!tablePass) {
    console.log(`error_code: ${sanitize(table.error?.code) ?? "UNKNOWN"}`);
    console.log(`error_message: ${sanitize(table.error?.message) ?? "Schema check failed"}`);
    console.log("\nRESULT = FAIL");
    process.exitCode = 1;
    return;
  }

  const projection = fixture.columns.map((column) => column.name).join(",");
  const columns = await client.from(fixture.table).select(projection, { head: true }).limit(1);
  console.log(`REQUIRED_COLUMNS = ${columns.error ? "FAIL" : "PASS"}`);
  if (columns.error) {
    console.log(`error_code: ${sanitize(columns.error.code) ?? "UNKNOWN"}`);
    console.log(`error_message: ${sanitize(columns.error.message) ?? "Required column check failed"}`);
  }

  const division = await client.from(fixture.table).select("division", { head: true }).limit(1);
  console.log(`DIVISION_COLUMN_EXISTS = ${!division.error}`);

  const unique = fixture.constraints.find(
    (constraint) => constraint.kind === "unique" && constraint.columns.join(",") === "telegram_chat_id",
  );
  console.log(`TELEGRAM_CHAT_ID_UNIQUE = ${unique?.live_status ?? "NOT_VERIFIED"}`);
  console.log(`APPLICATION_INDEXES = ${fixture.indexes.every((index) => index.live_status === "NOT_VERIFIED") ? "NOT_VERIFIED" : "PARTIAL"}`);
  console.log(`RLS_STATE = ${fixture.rls.live_status}`);
  console.log(`UPDATED_AT_TRIGGER = ${fixture.trigger.live_status}`);

  const passed = !columns.error && !division.error;
  console.log(`\nRESULT = ${passed ? "PASS" : "FAIL"}`);
  if (!passed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.log("TELEGRAM_USERS_TABLE = FAIL");
  console.log(`error_message: ${sanitize(error instanceof Error ? error.message : "Unexpected schema check failure")}`);
  console.log("\nRESULT = FAIL");
  process.exitCode = 1;
});
