import { readFile } from "node:fs/promises";
import path from "node:path";
import { createSupabaseClient } from "../src/db/supabase.js";
import { loadConfig } from "../src/config/env.js";
import { buildApp } from "../src/app.js";

const migration = await readFile(path.resolve(process.cwd(), "supabase/migrations/202608290003_create_it_user_management.sql"), "utf8");
const appSource = await readFile(path.resolve(process.cwd(), "src/app.ts"), "utf8");
const uiSource = await readFile(path.resolve(process.cwd(), "public/app.js"), "utf8");
const pass = (value: boolean) => value ? "PASS" : "FAIL";
const checks: Record<string, boolean> = {
  ATOMIC_ACCESS_WRITE: migration.includes("update public.users") && migration.includes("update public.telegram_users") && migration.includes("USER_DIVISION_CHANGED"),
  SERVICE_ONLY_RPC: migration.includes("grant execute on function public.update_user_access") && migration.includes("to service_role") && migration.includes("from public, anon, authenticated"),
  SYSTEM_ADMIN_INVARIANT: migration.includes("protect_final_system_admin") && migration.includes("gwens_system_admin_invariant"),
  NO_AUTO_ASSIGNMENT: !migration.split("create or replace function public.assign_system_admin")[0]?.includes("insert into public.system_authority_assignments"),
  PROTECTED_API: appSource.includes("/api/admin/users") && appSource.includes("adminApiKey"),
  DYNAMIC_UI_CATALOGS: uiSource.includes("/api/admin/users/catalogs") && !uiSource.includes("Sales Grosir"),
};

const config = loadConfig();
const client = createSupabaseClient(config);
const [{ count: total }, { count: active }, { count: pending }, { count: assignedInactive }, { count: itUsers }, { count: candidates }, { count: systemAdmins }] = await Promise.all([
  client.from("users").select("id", { count: "exact", head: true }),
  client.from("users").select("id", { count: "exact", head: true }).eq("active", true),
  client.from("users").select("id", { count: "exact", head: true }).eq("active", false).or("division_id.is.null,role_id.is.null"),
  client.from("users").select("id", { count: "exact", head: true }).eq("active", false).not("division_id", "is", null).not("role_id", "is", null),
  client.from("users").select("id,divisions!inner(code)", { count: "exact", head: true }).eq("divisions.code", "IT"),
  client.from("users").select("id,divisions!inner(code)", { count: "exact", head: true }).eq("active", true).eq("divisions.code", "IT"),
  client.from("system_authority_assignments").select("id", { count: "exact", head: true }).eq("authority_code", "SYSTEM_ADMIN").is("revoked_at", null),
]);

const { app } = await buildApp({ config, logger: false });
try {
  const denied = await app.inject({ method: "GET", url: "/api/admin/users?status=pending" });
  const headers = { "x-admin-api-key": config.adminApiKey ?? "" };
  const [listed, catalogs, authority] = await Promise.all([
    app.inject({ method: "GET", url: "/api/admin/users?status=pending", headers }),
    app.inject({ method: "GET", url: "/api/admin/users/catalogs", headers }),
    app.inject({ method: "GET", url: "/api/admin/system-authority/status", headers }),
  ]);
  checks.LIVE_API_PROTECTION = Boolean(config.adminApiKey) && denied.statusCode === 401;
  checks.LIVE_USER_LIST = listed.statusCode === 200 && listed.json().data?.length === (pending ?? 0);
  checks.LIVE_DYNAMIC_CATALOGS = catalogs.statusCode === 200 && catalogs.json().data?.divisions?.length > 0 && catalogs.json().data?.roles?.length > 0;
  checks.LIVE_AUTHORITY_STATUS = authority.statusCode === 200 && authority.json().data?.candidate_count === (candidates ?? 0);
} finally {
  await app.close();
}

console.log("Gwens IT User Management\n");
for (const [name, value] of Object.entries(checks)) console.log(`${name} = ${pass(value)}`);
console.log(`PENDING_USERS = ${pending ?? 0}`);
console.log(`ACTIVE_USERS = ${active ?? 0}`);
console.log(`INACTIVE_USERS = ${assignedInactive ?? 0}`);
console.log(`IT_DIVISION_USERS = ${itUsers ?? 0}`);
console.log(`SYSTEM_ADMIN_CANDIDATE_COUNT = ${candidates ?? 0}`);
console.log(`ACTIVE_SYSTEM_ADMINS = ${systemAdmins ?? 0}`);
console.log(`TOTAL_USERS = ${total ?? 0}`);
console.log(`SYSTEM_ADMIN_BOOTSTRAP = ${(candidates ?? 0) === 0 && (systemAdmins ?? 0) === 0 ? "WAITING_FOR_IT_USER_ASSIGNMENT" : "READY"}`);
console.log(`\nRESULT = ${pass(Object.values(checks).every(Boolean))}`);
if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
