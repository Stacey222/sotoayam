import "dotenv/config";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

// Counts only: this command never selects row values or sends a mutation.
const TABLES = [
  "users", "telegram_users", "user_channels", "admin_credentials", "admin_sessions", "admin_login_attempts",
  "system_authority_assignments", "roles", "role_permissions", "permissions", "divisions", "audit_logs",
  "tasks", "task_activities", "task_relationships", "task_reminder_states", "task_import_batches",
  "task_source_integrations", "integration_capabilities", "integration_credentials", "division_collaboration_rules",
  "notifications", "notification_deliveries", "notification_events", "notification_routing_rules",
  "telegram_notification_preferences", "telegram_polling_state", "telegram_processed_updates",
  "critical_alerts", "critical_alert_evaluator_state", "reminder_scheduler_state",
  "task_categories", "installation_provenance", "instance_bootstrap", "instance_settings",
] as const;

async function main(): Promise<void> {
  const ref = readFileSync("supabase/.temp/project-ref", "utf8").trim();
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!ref || !url || !key || new URL(url).hostname !== `${ref}.supabase.co`) {
    throw new Error("The configured database is not the linked Supabase project; inventory refused");
  }
  console.log(`LINKED_PROJECT_REF = ${ref}`);
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  let incomplete = false;
  for (const table of TABLES) {
    const { count, error, status } = await client.from(table).select("*", { head: true, count: "exact" });
    if (error || count === null) {
      console.log(`${table.toUpperCase()} = NOT_AVAILABLE (HTTP_${status})`);
      incomplete = true;
      continue;
    }
    console.log(`${table.toUpperCase()} = ${count}`);
  }
  const ownerCredential = await client.from("admin_credentials").select("user_id,password_change_required")
    .ilike("email", "owner@sotoayam.local").maybeSingle();
  if (ownerCredential.error) throw new Error("OWNER_CREDENTIAL_CHECK_FAILED");
  console.log(`OWNER_CREDENTIAL = ${ownerCredential.data ? "PRESENT" : "ABSENT"}`);
  if (ownerCredential.data) {
    const ownerId = ownerCredential.data.user_id;
    const [user, authority, channel, settings] = await Promise.all([
      client.from("users").select("display_name,active,division_id,role_id,legacy_telegram_user_id").eq("id", ownerId).maybeSingle(),
      client.from("system_authority_assignments").select("id", { count: "exact", head: true })
        .eq("user_id", ownerId).is("revoked_at", null),
      client.from("user_channels").select("id", { count: "exact", head: true }).eq("user_id", ownerId),
      client.rpc("get_instance_settings"),
    ]);
    if (user.error || authority.error || channel.error || settings.error) throw new Error("OWNER_INVARIANT_CHECK_FAILED");
    console.log(`OWNER_DISPLAY_KENTO = ${user.data?.display_name === "Kento" ? "YES" : "NO"}`);
    console.log(`OWNER_ACTIVE = ${user.data?.active === true ? "YES" : "NO"}`);
    console.log(`OWNER_PASSWORD_CHANGE_REQUIRED = ${ownerCredential.data.password_change_required === true ? "YES" : "NO"}`);
    if (user.data?.role_id) {
      const role = await client.from("roles").select("code").eq("id", user.data.role_id).maybeSingle();
      if (role.error) throw new Error("OWNER_ROLE_CHECK_FAILED");
      console.log(`OWNER_ROLE = ${role.data?.code ?? "NOT_AVAILABLE"}`);
    }
    const ownerRole = await client.from("roles").select("id").eq("code", "OWNER").maybeSingle();
    if (ownerRole.error || !ownerRole.data) throw new Error("OWNER_ROLE_CHECK_FAILED");
    const otherOwners = await client.from("users").select("id", { count: "exact", head: true })
      .eq("role_id", ownerRole.data.id).eq("active", true).neq("id", ownerId);
    console.log(`OTHER_ACTIVE_OWNER_USERS = ${otherOwners.error ? "NOT_AVAILABLE" : otherOwners.count ?? "NOT_AVAILABLE"}`);
    if (user.data?.division_id) {
      const division = await client.from("divisions").select("active,grants_system_authority")
        .eq("id", user.data.division_id).maybeSingle();
      if (division.error) throw new Error("OWNER_DIVISION_CHECK_FAILED");
      console.log(`OWNER_DIVISION_AUTHORITY_CAPABLE = ${division.data?.active === true &&
        division.data.grants_system_authority === true ? "YES" : "NO"}`);
    }
    console.log(`OWNER_AUTHORITY_ASSIGNMENTS = ${authority.count ?? "NOT_AVAILABLE"}`);
    console.log(`OWNER_TELEGRAM_LINKS = ${channel.count ?? "NOT_AVAILABLE"}`);
    console.log(`OWNER_LEGACY_TELEGRAM_LINK = ${user.data?.legacy_telegram_user_id ? "YES" : "NO"}`);
    const settingsRow = Array.isArray(settings.data) ? settings.data[0] : settings.data;
    console.log(`BUSINESS_ACTOR_STATE = ${settingsRow?.business_actor_user_id === ownerId ? "OWNER" :
      settingsRow?.business_actor_user_id == null ? "UNSET" : "OTHER_USER"}`);
  }
  if (incomplete) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Inventory failed");
  process.exitCode = 1;
});
