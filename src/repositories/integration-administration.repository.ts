import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../errors.js";
import type { IntegrationCapabilityCode, TaskSourceIntegration } from "./task-ingestion.repository.js";
import { governanceDatabaseError } from "./governance-database-error.js";

export interface IntegrationCapability {
  id: number;
  integration_id: number;
  capability_code: IntegrationCapabilityCode;
  granted_at: string;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface IntegrationAdministrationRepository {
  list(): Promise<TaskSourceIntegration[]>;
  findById(id: number): Promise<TaskSourceIntegration | null>;
  create(input: { code: string; name: string; source: "AUTOMATION" | "ERP"; requestingDivisionId: number; actorUserId: number }): Promise<TaskSourceIntegration>;
  setActive(id: number, active: boolean, actorUserId: number): Promise<TaskSourceIntegration>;
  listCapabilities(id: number): Promise<IntegrationCapability[]>;
  grantCapability(id: number, capability: IntegrationCapabilityCode, actorUserId: number): Promise<IntegrationCapability>;
  revokeCapability(id: number, capability: IntegrationCapabilityCode, actorUserId: number): Promise<IntegrationCapability>;
}

function databaseError(message: string, error: { code?: string; message?: string; details?: string; hint?: string }): Error {
  if (error.code === "42501") return new AppError(403, "INTEGRATION_ADMIN_FORBIDDEN", "Active SYSTEM_ADMIN authority in an authority-capable division is required");
  if (error.code === "P0002") return new AppError(404, "INTEGRATION_NOT_FOUND", error.message ?? "Integration state was not found");
  if (error.code === "23505") return new AppError(409, "INTEGRATION_DUPLICATE", "Integration identity or capability already exists");
  if (["23503", "23514", "22023"].includes(error.code ?? "")) return new AppError(400, "INTEGRATION_INVALID", error.message ?? message);
  return governanceDatabaseError(message, error);
}

const integrationSelection = "id,code,name,source,requesting_division_id,active";
const capabilitySelection = "id,integration_id,capability_code,granted_at,revoked_at,created_at,updated_at";

export class SupabaseIntegrationAdministrationRepository implements IntegrationAdministrationRepository {
  constructor(private readonly client: SupabaseClient) {}

  async list(): Promise<TaskSourceIntegration[]> {
    const { data, error } = await this.client.from("task_source_integrations").select(integrationSelection).order("code");
    if (error) throw databaseError("Unable to list integration identities", error);
    return (data ?? []) as TaskSourceIntegration[];
  }

  async findById(id: number): Promise<TaskSourceIntegration | null> {
    const { data, error } = await this.client.from("task_source_integrations").select(integrationSelection).eq("id", id).maybeSingle();
    if (error) throw databaseError("Unable to load integration identity", error);
    return data as TaskSourceIntegration | null;
  }

  async create(input: { code: string; name: string; source: "AUTOMATION" | "ERP"; requestingDivisionId: number; actorUserId: number }): Promise<TaskSourceIntegration> {
    const { data, error } = await this.client.rpc("create_task_source_integration", {
      p_code: input.code, p_name: input.name, p_source: input.source,
      p_requesting_division_id: input.requestingDivisionId, p_actor_user_id: input.actorUserId,
    }).single();
    if (error) throw databaseError("Unable to create integration identity", error);
    return data as TaskSourceIntegration;
  }

  async setActive(id: number, active: boolean, actorUserId: number): Promise<TaskSourceIntegration> {
    const { data, error } = await this.client.rpc("set_task_source_integration_active", {
      p_integration_id: id, p_active: active, p_actor_user_id: actorUserId,
    }).single();
    if (error) throw databaseError("Unable to update integration identity", error);
    return data as TaskSourceIntegration;
  }

  async listCapabilities(id: number): Promise<IntegrationCapability[]> {
    const { data, error } = await this.client.from("integration_capabilities").select(capabilitySelection).eq("integration_id", id).order("capability_code");
    if (error) throw databaseError("Unable to list integration capabilities", error);
    return (data ?? []) as IntegrationCapability[];
  }

  async grantCapability(id: number, capability: IntegrationCapabilityCode, actorUserId: number): Promise<IntegrationCapability> {
    const { data, error } = await this.client.rpc("grant_integration_capability", {
      p_integration_id: id, p_capability_code: capability, p_actor_user_id: actorUserId,
    }).single();
    if (error) throw databaseError("Unable to grant integration capability", error);
    return data as IntegrationCapability;
  }

  async revokeCapability(id: number, capability: IntegrationCapabilityCode, actorUserId: number): Promise<IntegrationCapability> {
    const { data, error } = await this.client.rpc("revoke_integration_capability", {
      p_integration_id: id, p_capability_code: capability, p_actor_user_id: actorUserId,
    }).single();
    if (error) throw databaseError("Unable to revoke integration capability", error);
    return data as IntegrationCapability;
  }
}
