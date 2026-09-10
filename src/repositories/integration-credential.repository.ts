import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../errors.js";
import type { IntegrationAuthenticationStatus, IntegrationPrincipal } from "../auth/integration-credential.js";
import type { IntegrationCapabilityCode } from "./task-ingestion.repository.js";
import { governanceDatabaseError } from "./governance-database-error.js";

export type IntegrationCredentialRevocationReason = "ROTATED" | "COMPROMISED" | "DECOMMISSIONED" | "INTEGRATION_DISABLED";
export type IntegrationCredentialStatus = "ACTIVE" | "EXPIRED" | "REVOKED";

export interface IntegrationCredentialMetadata {
  id: number;
  integration_id: number;
  selector: string;
  label: string;
  created_at: string;
  created_by_user_id: number;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_reason: IntegrationCredentialRevocationReason | null;
  rotation_of_credential_id: number | null;
  status: IntegrationCredentialStatus;
}

export interface IntegrationCredentialAuthenticationResult {
  status: IntegrationAuthenticationStatus;
  principal: IntegrationPrincipal | null;
}

export interface IntegrationCredentialRepository {
  authenticate(selector: string, secretHash: string, requiredCapability: IntegrationCapabilityCode | null): Promise<IntegrationCredentialAuthenticationResult>;
  create(input: { integrationId: number; selector: string; secretHash: string; label: string;
    expiresAt: string | null; rotationOfCredentialId: number | null; actorUserId: number }): Promise<IntegrationCredentialMetadata>;
  list(integrationId: number, actorUserId: number): Promise<IntegrationCredentialMetadata[]>;
  revoke(input: { credentialId: number; reason: IntegrationCredentialRevocationReason;
    graceSeconds: number | null; actorUserId: number }): Promise<IntegrationCredentialMetadata>;
  revokeAll(input: { integrationId: number; reason: IntegrationCredentialRevocationReason; actorUserId: number }): Promise<number>;
}

interface AuthenticationRow {
  status: IntegrationAuthenticationStatus;
  credential_id: number | null;
  integration_id: number | null;
  code: string | null;
  source: "AUTOMATION" | "ERP" | null;
  requesting_division_id: number | null;
}

function databaseError(message: string, error: { code?: string; message?: string; details?: string; hint?: string }): Error {
  if (error.code === "42501") return new AppError(403, "INTEGRATION_ADMIN_FORBIDDEN", "Active SYSTEM_ADMIN authority in an authority-capable division is required");
  if (error.code === "P0002") return new AppError(404, "INTEGRATION_CREDENTIAL_NOT_FOUND", error.message ?? "Integration credential was not found");
  if (error.code === "P0001") return new AppError(409, "INTEGRATION_CREDENTIAL_LIMIT", "At most two active credentials are allowed per integration");
  if (["23503", "23514", "22023"].includes(error.code ?? "")) return new AppError(400, "INTEGRATION_CREDENTIAL_INVALID", error.message ?? message);
  if (error.code === "23505") return new AppError(409, "INTEGRATION_CREDENTIAL_CONFLICT", "Integration credential selector already exists");
  return governanceDatabaseError(message, error);
}

function metadata(row: Record<string, unknown>): IntegrationCredentialMetadata {
  return {
    id: Number(row.id), integration_id: Number(row.integration_id), selector: String(row.selector), label: String(row.label),
    created_at: String(row.created_at), created_by_user_id: Number(row.created_by_user_id),
    last_used_at: row.last_used_at === null ? null : String(row.last_used_at),
    expires_at: row.expires_at === null ? null : String(row.expires_at),
    revoked_at: row.revoked_at === null ? null : String(row.revoked_at),
    revoked_reason: row.revoked_reason as IntegrationCredentialRevocationReason | null,
    rotation_of_credential_id: row.rotation_of_credential_id === null ? null : Number(row.rotation_of_credential_id),
    status: row.status as IntegrationCredentialStatus,
  };
}

export class SupabaseIntegrationCredentialRepository implements IntegrationCredentialRepository {
  constructor(private readonly client: SupabaseClient) {}

  async authenticate(selector: string, secretHash: string, requiredCapability: IntegrationCapabilityCode | null): Promise<IntegrationCredentialAuthenticationResult> {
    const { data, error } = await this.client.rpc("authenticate_integration_credential", {
      p_selector: selector, p_secret_hash: secretHash, p_required_capability: requiredCapability,
    }).single();
    if (error) throw governanceDatabaseError("Unable to authenticate integration credential", error);
    const row = data as unknown as AuthenticationRow;
    const principal = row.status === "OK" && row.credential_id !== null && row.integration_id !== null
      ? { integrationId: Number(row.integration_id), credentialId: Number(row.credential_id), code: row.code!,
          source: row.source!, requestingDivisionId: Number(row.requesting_division_id) }
      : null;
    return { status: row.status, principal };
  }

  async create(input: Parameters<IntegrationCredentialRepository["create"]>[0]): Promise<IntegrationCredentialMetadata> {
    const { data, error } = await this.client.rpc("create_integration_credential", {
      p_integration_id: input.integrationId, p_selector: input.selector, p_secret_hash: input.secretHash,
      p_label: input.label, p_expires_at: input.expiresAt, p_rotation_of_credential_id: input.rotationOfCredentialId,
      p_actor_user_id: input.actorUserId,
    }).single();
    if (error) throw databaseError("Unable to create integration credential", error);
    return metadata(data as Record<string, unknown>);
  }

  async list(integrationId: number, actorUserId: number): Promise<IntegrationCredentialMetadata[]> {
    const { data, error } = await this.client.rpc("list_integration_credentials", {
      p_integration_id: integrationId, p_actor_user_id: actorUserId,
    });
    if (error) throw databaseError("Unable to list integration credentials", error);
    return ((data ?? []) as Record<string, unknown>[]).map(metadata);
  }

  async revoke(input: Parameters<IntegrationCredentialRepository["revoke"]>[0]): Promise<IntegrationCredentialMetadata> {
    const { data, error } = await this.client.rpc("revoke_integration_credential", {
      p_credential_id: input.credentialId, p_reason: input.reason,
      p_grace_seconds: input.graceSeconds, p_actor_user_id: input.actorUserId,
    }).single();
    if (error) throw databaseError("Unable to revoke integration credential", error);
    return metadata(data as Record<string, unknown>);
  }

  async revokeAll(input: Parameters<IntegrationCredentialRepository["revokeAll"]>[0]): Promise<number> {
    const { data, error } = await this.client.rpc("revoke_integration_credentials_for_integration", {
      p_integration_id: input.integrationId, p_reason: input.reason, p_actor_user_id: input.actorUserId,
    });
    if (error) throw databaseError("Unable to revoke integration credentials", error);
    return Number(data);
  }
}
