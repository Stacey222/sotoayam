import "dotenv/config";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const EMAIL = "owner@sotoayam.local";
const REQUIRED = ["task.view_assigned", "task.create", "task.update_assigned", "task.complete_assigned",
  "task.add_activity", "task.view_division", "report.view_cross_division", "alert.view_critical",
  "alert.acknowledge", "approval.view", "approval.decide", "automation_status.view_business", "threshold.manage"];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const ref = readFileSync("supabase/.temp/project-ref", "utf8").trim();
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  assert(process.env.NODE_ENV !== "production", "Production environment refused");
  assert(ref && process.env.SOTOAYAM_EXPECTED_DEV_PROJECT_REF === ref, "Explicit linked development project ref is required");
  assert(process.env.SOTOAYAM_OWNER_CONFIRM === "PREPARE_KENTO_OWNER_ON_LINKED_DEV", "Explicit owner preparation confirmation is required");
  assert(url && key && new URL(url).hostname === `${ref}.supabase.co`, "Configured Supabase target does not match the linked project");
  console.log(`TARGET_PROJECT_REF = ${ref}`);
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const [credentials, roles, permissions, settings] = await Promise.all([
    client.from("admin_credentials").select("user_id,password_change_required").ilike("email", EMAIL),
    client.from("roles").select("id,code,active").in("code", ["ADMIN", "OWNER"]),
    client.from("permissions").select("id,code,active"),
    client.rpc("get_instance_settings"),
  ]);
  assert(!credentials.error && credentials.data?.length === 1, "Exactly one Kento login credential is required");
  assert(credentials.data[0]!.password_change_required !== true, "Kento must complete the password-change gate first");
  assert(!roles.error && roles.data?.length === 2 && roles.data.every((role) => role.active), "Active ADMIN and OWNER roles are required");
  assert(!permissions.error && permissions.data, "Permission inventory unavailable");
  assert(!settings.error && settings.data, "Runtime settings RPC unavailable");
  const kentoId = credentials.data[0]!.user_id;
  const adminRole = roles.data.find((role) => role.code === "ADMIN")!;
  const ownerRole = roles.data.find((role) => role.code === "OWNER")!;
  const otherOwners = await client.from("users").select("id", { head: true, count: "exact" })
    .eq("role_id", ownerRole.id).eq("active", true).neq("id", kentoId);
  assert(!otherOwners.error && otherOwners.count === 0,
    "Another active OWNER exists; sole-OWNER preparation requires an explicit legacy-account decision first");
  const settingsRow = Array.isArray(settings.data) ? settings.data[0] : settings.data;
  assert(settingsRow && (settingsRow.business_actor_user_id === null || settingsRow.business_actor_user_id === kentoId),
    "A different business actor is already designated");
  const ownerGrants = await client.from("role_permissions").select("permission_id").eq("role_id", ownerRole.id);
  assert(!ownerGrants.error && ownerGrants.data, "OWNER grants are unavailable");
  const permissionIds = new Set(ownerGrants.data.map((row) => row.permission_id));
  const activeCodes = new Set(permissions.data.filter((row) => row.active && permissionIds.has(row.id)).map((row) => row.code));
  assert(REQUIRED.every((code) => activeCodes.has(code)), "OWNER lacks required MVP task/business grants; apply verified migration first");
  const user = await client.from("users").select("id,display_name,active,division_id,role_id").eq("id", kentoId).maybeSingle();
  assert(!user.error && user.data?.display_name === "Kento" && user.data.active && user.data.division_id,
    "Kento identity or active Divisi is not as expected");
  assert(user.data.role_id === adminRole.id || user.data.role_id === ownerRole.id, "Kento has an unexpected role");
  const division = await client.from("divisions").select("active,grants_system_authority").eq("id", user.data.division_id).maybeSingle();
  assert(!division.error && division.data?.active && division.data.grants_system_authority,
    "Kento's Divisi cannot retain effective SYSTEM_ADMIN");
  const assignment = await client.from("system_authority_assignments").select("id", { count: "exact", head: true })
    .eq("user_id", kentoId).is("revoked_at", null);
  assert(!assignment.error && assignment.count === 1, "Kento must have one active SYSTEM_ADMIN assignment");
  console.log("PRECHECK = PASS");
  if (user.data.role_id === adminRole.id) {
    const changed = await client.rpc("update_managed_user_access", {
      p_user_id: kentoId, p_division_id: user.data.division_id, p_role_id: ownerRole.id, p_active: true,
      p_actor_user_id: kentoId, p_source: "owner_mvp_preparation", p_confirm: false,
      p_reason: "Designate Kento as sole OWNER business actor",
    });
    assert(!changed.error, `Guarded OWNER role transition failed (${changed.error?.code ?? "UNKNOWN"})`);
    console.log("OWNER_ROLE = APPLIED");
  } else console.log("OWNER_ROLE = ALREADY_APPLIED");
  if (settingsRow.business_actor_user_id === null) {
    const designated = await client.rpc("set_instance_business_actor", {
      p_actor_user_id: kentoId, p_expected_version: settingsRow.version,
      p_business_actor_user_id: kentoId, p_reason: "Designate Kento as sole OWNER business actor",
    });
    assert(!designated.error, `Business actor designation failed (${designated.error?.code ?? "UNKNOWN"})`);
    console.log("BUSINESS_ACTOR = APPLIED");
  } else console.log("BUSINESS_ACTOR = ALREADY_APPLIED");
  const [finalUser, finalSettings, finalAssignment] = await Promise.all([
    client.from("users").select("active,role_id").eq("id", kentoId).maybeSingle(),
    client.rpc("get_instance_settings"),
    client.from("system_authority_assignments").select("id", { head: true, count: "exact" })
      .eq("user_id", kentoId).is("revoked_at", null),
  ]);
  const finalSettingsRow = Array.isArray(finalSettings.data) ? finalSettings.data[0] : finalSettings.data;
  assert(!finalUser.error && finalUser.data?.active && finalUser.data.role_id === ownerRole.id
    && !finalSettings.error && finalSettingsRow?.business_actor_user_id === kentoId
    && finalSettingsRow.business_actor_eligible === true
    && !finalAssignment.error && finalAssignment.count === 1, "Final OWNER/SYSTEM_ADMIN verification failed");
  console.log("FINAL_OWNER_SYSTEM_ADMIN_BUSINESS_ACTOR = PASS");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Owner preparation failed");
  process.exitCode = 1;
});
