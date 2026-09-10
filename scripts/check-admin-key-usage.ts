import { createSupabaseClient } from "../src/db/supabase.js";
import { loadSupabaseConfig } from "../src/config/env.js";

function sinceArgument(argv: string[]): string {
  if (argv.length !== 2 || argv[0] !== "--since" || !argv[1] || !Number.isFinite(Date.parse(argv[1]))) {
    throw new Error("Usage: npm run check:admin-key-usage -- --since <ISO timestamp>");
  }
  return new Date(argv[1]).toISOString();
}

async function main(): Promise<void> {
  const since = sinceArgument(process.argv.slice(2));
  const client = createSupabaseClient(loadSupabaseConfig());
  const { data, error } = await client.from("audit_logs").select("created_at")
    .eq("action", "ADMIN_API_KEY_FALLBACK_USED").gte("created_at", since).order("created_at");
  if (error) throw new Error("Unable to inspect administrator API-key fallback usage");
  const dates = (data ?? []).map((row) => String(row.created_at));
  console.log(dates.length === 0 ? "ADMIN_API_KEY = SAFE TO DISABLE" : "ADMIN_API_KEY = FALLBACK STILL IN USE");
  if (dates.length > 0) console.log(`usage_dates: ${dates.join(",")}`);
}

main().catch((error: unknown) => {
  console.log("ADMIN_API_KEY = NOT VERIFIED");
  console.log(`error_type: ${error instanceof Error ? error.name : "UnknownError"}`);
  process.exitCode = 1;
});
