import { randomInt, randomUUID } from "node:crypto";
import "dotenv/config";
import type { PostgrestError } from "@supabase/supabase-js";
import { loadSupabaseConfig } from "../src/config/env.js";
import { createSupabaseClient } from "../src/db/supabase.js";

const REQUIRED_COLUMNS = [
  "telegram_chat_id",
  "telegram_username",
  "telegram_first_name",
  "name",
  "division",
  "role",
  "active",
  "stock_alert",
  "purchase_alert",
  "sales_alert",
  "marketing_alert",
  "content_alert",
  "owner_report",
  "system_error",
  "created_at",
  "updated_at",
] as const;

type SafeError = Pick<PostgrestError, "code" | "message" | "hint">;

function sanitize(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  let safe = value;
  for (const secret of [
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.TELEGRAM_BOT_TOKEN,
  ]) {
    if (secret) safe = safe.replaceAll(secret, "[REDACTED]");
  }
  return safe
    .replace(/https?:\/\/\S+/gi, "[REDACTED_URL]")
    .replace(/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, "[REDACTED_KEY]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED_JWT]")
    .replace(/authorization\s*[:=]\s*\S+/gi, "authorization=[REDACTED]")
    .slice(0, 300);
}

function printError(error: SafeError): void {
  const code = sanitize(error.code);
  const message = sanitize(error.message);
  const hint = sanitize(error.hint);
  if (code) console.log(`error_code: ${code}`);
  if (message) console.log(`error_message: ${message}`);
  if (hint) console.log(`hint: ${hint}`);
}

function isCredentialFailure(error: SafeError): boolean {
  const message = error.message.toLowerCase();
  return error.code === "PGRST301" || message.includes("invalid api key") || message.includes("invalid jwt");
}

function isConnectionFailure(error: SafeError): boolean {
  const message = error.message.toLowerCase();
  return message.includes("fetch failed")
    || message.includes("network")
    || message.includes("enotfound")
    || message.includes("econnrefused");
}

async function main(): Promise<void> {
  console.log("Gwens Supabase Diagnostic\n");

  const environmentPresent = Boolean(
    process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
  );
  console.log(`SUPABASE_ENV = ${environmentPresent ? "PASS" : "FAIL"}`);
  if (!environmentPresent) {
    console.log("\nRESULT = FAIL");
    process.exitCode = 1;
    return;
  }

  let config;
  try {
    config = loadSupabaseConfig();
  } catch (error) {
    console.log("SUPABASE_CONNECTION = FAIL");
    console.log("SERVER_CREDENTIAL_ACCEPTED = false");
    if (error instanceof Error) console.log(`error_message: ${sanitize(error.message)}`);
    console.log("\nRESULT = FAIL");
    process.exitCode = 1;
    return;
  }

  const client = createSupabaseClient(config);
  const tableRead = await client.from("telegram_users").select("id").limit(1);
  if (tableRead.error && (isCredentialFailure(tableRead.error) || isConnectionFailure(tableRead.error))) {
    console.log("SUPABASE_CONNECTION = FAIL");
    console.log("SERVER_CREDENTIAL_ACCEPTED = false");
    console.log("TELEGRAM_USERS_TABLE = FAIL");
    printError(tableRead.error);
    console.log("\nRESULT = FAIL");
    process.exitCode = 1;
    return;
  }

  if (tableRead.error) {
    console.log("SUPABASE_CONNECTION = PASS");
    console.log("SERVER_CREDENTIAL_ACCEPTED = true");
    console.log("TELEGRAM_USERS_TABLE = FAIL");
    printError(tableRead.error);
    console.log("\nRESULT = FAIL");
    process.exitCode = 1;
    return;
  }

  console.log("SUPABASE_CONNECTION = PASS");
  console.log("SERVER_CREDENTIAL_ACCEPTED = true");
  console.log("TELEGRAM_USERS_TABLE = PASS");

  const columns = await client.from("telegram_users").select(REQUIRED_COLUMNS.join(",")).limit(1);
  const division = await client.from("telegram_users").select("division").limit(1);
  console.log(`DIVISION_COLUMN_EXISTS = ${!division.error}`);
  if (columns.error) printError(columns.error);

  let serverWritePassed = false;
  let diagnosticChatId: number | undefined;
  const marker = `gwens_diagnostic_${randomUUID()}`;

  for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = -(8_600_000_000_000_000 + randomInt(0, 100_000_000));
      const existing = await client
        .from("telegram_users")
        .select("id", { count: "exact", head: true })
        .eq("telegram_chat_id", candidate);
      if (!existing.error && existing.count === 0) {
        diagnosticChatId = candidate;
        break;
      }
  }

  if (diagnosticChatId === undefined) {
    console.log("SERVER_WRITE = FAIL");
    console.log("error_message: Unable to reserve a unique diagnostic identifier");
  } else {
      let insertVerified = false;
      let cleanupVerified = false;
      let writeError: SafeError | undefined;
      try {
        const inserted = await client
          .from("telegram_users")
          .insert({
            telegram_chat_id: diagnosticChatId,
            telegram_username: marker,
            telegram_first_name: "Gwens Diagnostic",
          })
          .select("id")
          .single();
        if (inserted.error) {
          writeError = inserted.error;
        } else {
          const verified = await client
            .from("telegram_users")
            .select("id", { count: "exact", head: true })
            .eq("telegram_chat_id", diagnosticChatId)
            .eq("telegram_username", marker);
          if (verified.error) writeError = verified.error;
          else insertVerified = verified.count === 1;
        }
      } catch (error) {
        writeError = { code: "DIAGNOSTIC_ERROR", message: error instanceof Error ? error.message : "Write probe failed", hint: "" };
      } finally {
        const removed = await client
          .from("telegram_users")
          .delete()
          .eq("telegram_chat_id", diagnosticChatId)
          .eq("telegram_username", marker);
        const cleanupCheck = await client
          .from("telegram_users")
          .select("id", { count: "exact", head: true })
          .eq("telegram_chat_id", diagnosticChatId)
          .eq("telegram_username", marker);
        cleanupVerified = !removed.error && !cleanupCheck.error && cleanupCheck.count === 0;
        if (!writeError) writeError = removed.error ?? cleanupCheck.error ?? undefined;
      }

      serverWritePassed = insertVerified && cleanupVerified;
      console.log(`SERVER_WRITE = ${serverWritePassed ? "PASS" : "FAIL"}`);
      if (writeError) printError(writeError);
      else if (!serverWritePassed) console.log("error_message: Diagnostic record cleanup could not be verified");
  }

  const passed = !columns.error && !division.error && serverWritePassed;
  console.log(`\nRESULT = ${passed ? "PASS" : "FAIL"}`);
  if (!passed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.log("SUPABASE_CONNECTION = FAIL");
  console.log("SERVER_CREDENTIAL_ACCEPTED = false");
  console.log(`error_message: ${sanitize(error instanceof Error ? error.message : "Unexpected diagnostic failure")}`);
  console.log("\nRESULT = FAIL");
  process.exitCode = 1;
});