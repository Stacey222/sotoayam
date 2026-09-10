import { createSupabaseClient } from "../src/db/supabase.js";
import { loadSupabaseConfig } from "../src/config/env.js";
import { SupabaseIntegrationAdministrationRepository } from "../src/repositories/integration-administration.repository.js";
import { SupabaseIntegrationCredentialRepository } from "../src/repositories/integration-credential.repository.js";
import { SupabaseTaskUsersRepository } from "../src/repositories/task-users.repository.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length !== 2 || argv[0] !== "--since" || !argv[1] || !Number.isFinite(Date.parse(argv[1]))) {
    throw new Error("Usage: npm run check:integration-credentials -- --since <upgrade ISO timestamp>");
  }
  const since = new Date(argv[1]).toISOString();
  const client = createSupabaseClient(loadSupabaseConfig());
  const actor = await new SupabaseTaskUsersRepository(client).findTrustedAdminActorUser();
  const integrations = (await new SupabaseIntegrationAdministrationRepository(client).list()).filter((item) => item.active);
  const credentials = new SupabaseIntegrationCredentialRepository(client);
  const missing: string[] = [];
  for (const integration of integrations) {
    const usable = (await credentials.list(integration.id, actor.id))
      .some((credential) => credential.status === "ACTIVE" && credential.last_used_at !== null);
    if (!usable) missing.push(integration.code);
  }
  const { count, error } = await client.from("audit_logs").select("id", { count: "exact", head: true })
    .eq("action", "INTERNAL_API_KEY_FALLBACK_USED").gte("created_at", since);
  if (error) throw new Error("Unable to inspect internal-key fallback usage");
  const safe = missing.length === 0 && count === 0;
  console.log(`INTEGRATION_CREDENTIALS = ${safe ? "SAFE TO DISABLE FALLBACK" : "FALLBACK STILL REQUIRED"}`);
  console.log(`active_integrations_without_observed_credential: ${missing.length}`);
  console.log(`fallback_audit_count: ${count ?? 0}`);
}

main().catch((error: unknown) => {
  console.log("INTEGRATION_CREDENTIALS = NOT VERIFIED");
  console.log(`error_type: ${error instanceof Error ? error.name : "UnknownError"}`);
  process.exitCode = 1;
});
