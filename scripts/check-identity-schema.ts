import { readFile } from "node:fs/promises";
import path from "node:path";
import "dotenv/config";
import { loadSupabaseConfig } from "../src/config/env.js";
import { createSupabaseClient } from "../src/db/supabase.js";

const MIGRATION = "202608290002_create_normalized_identity.sql";

async function main(): Promise<void> {
  console.log("Sotoayam Normalized Identity Schema\n");
  const sql = await readFile(path.resolve(process.cwd(), "supabase/migrations", MIGRATION), "utf8");
  const usersBlock = sql.match(/create table if not exists public\.users \(([\s\S]*?)\n\);/)?.[1] ?? "";
  const channelsBlock = sql.match(/create table if not exists public\.user_channels \(([\s\S]*?)\n\);/)?.[1] ?? "";
  const checks = {
    USERS_TABLE: usersBlock.includes("legacy_telegram_user_id")
      && usersBlock.includes("division_id") && usersBlock.includes("role_id"),
    USER_CHANNELS_TABLE: channelsBlock.includes("channel_type") && channelsBlock.includes("external_id"),
    CHANNEL_IDENTITY_UNIQUE: channelsBlock.includes("unique (channel_type, external_id)"),
    RLS: sql.includes("alter table public.users enable row level security")
      && sql.includes("alter table public.user_channels enable row level security"),
    NO_PUBLIC_POLICIES: !/create\s+policy/i.test(sql),
    NON_DESTRUCTIVE: !/\b(?:drop\s+table|truncate|delete\s+from)\b/i.test(sql),
    NO_ROUTING_FIELDS: !/create table if not exists public\.(?:users|user_channels)[\s\S]*?(?:stock_alert|owner_report|system_error)/i.test(sql),
    IDEMPOTENT_BACKFILL: sql.includes("on conflict (legacy_telegram_user_id) do update")
      && sql.includes("on conflict (channel_type, external_id) do update"),
    ATOMIC_DUAL_WRITE: sql.includes("function public.register_telegram_identity")
      && sql.includes("security definer"),
    SERVICE_ONLY_FUNCTION: sql.includes("grant execute on function public.register_telegram_identity(bigint, text, text) to service_role")
      && sql.includes("revoke all on function public.register_telegram_identity(bigint, text, text) from public"),
    NO_SYSTEM_ADMIN_AUTO_ASSIGNMENT: !/insert into public\.system_authority_assignments/i.test(sql),
  };

  for (const [name, passed] of Object.entries(checks)) console.log(`${name} = ${passed ? "PASS" : "FAIL"}`);

  const client = createSupabaseClient(loadSupabaseConfig());
  const [users, channels] = await Promise.all([
    client.from("users").select("id,display_name,division_id,role_id,active,legacy_telegram_user_id,created_at,updated_at").limit(1),
    client.from("user_channels").select("id,user_id,channel_type,external_id,username,active,verified_at,created_at,updated_at").limit(1),
  ]);
  const pending = users.error?.code === "PGRST205" || channels.error?.code === "PGRST205";
  const livePassed = !users.error && !channels.error;
  console.log(`LIVE_IDENTITY_SCHEMA = ${pending ? "PENDING_MIGRATION" : livePassed ? "PASS" : "FAIL"}`);

  const passed = Object.values(checks).every(Boolean) && (pending || livePassed);
  console.log(`\nRESULT = ${passed ? "PASS" : "FAIL"}`);
  if (!passed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.log("LIVE_IDENTITY_SCHEMA = FAIL");
  console.log(`error_type: ${error instanceof Error ? error.name : "UnknownError"}`);
  console.log("\nRESULT = FAIL");
  process.exitCode = 1;
});
