import type { SupabaseClient } from "@supabase/supabase-js";
import { DatabaseError, type DatabaseDiagnostic } from "../errors.js";
import { governanceDatabaseError } from "./governance-database-error.js";

export type FirstAdminBootstrapCode =
  | "FIRST_ADMIN_ALREADY_EXISTS"
  | "INVALID_EMAIL"
  | "WEAK_PASSWORD"
  | "INVALID_DISPLAY_NAME"
  | "EMAIL_ALREADY_REGISTERED"
  | "MISSING_CONFIGURATION"
  | "INCOMPATIBLE_SCHEMA"
  | "TAXONOMY_UNAVAILABLE"
  | "INVALID_CREDENTIAL_MATERIAL"
  | "BOOTSTRAP_INPUT_UNAVAILABLE"
  | "INVALID_INSTALLATION_LINEAGE"
  | "FRESH_INSTALL_EVIDENCE_VETO"
  | "FRESH_INSTALL_SEED_MISMATCH"
  | "BOOTSTRAP_TRANSACTION_FAILED";

export const BOOTSTRAP_EXIT_CODES: Record<FirstAdminBootstrapCode, number> = {
  FIRST_ADMIN_ALREADY_EXISTS: 3,
  INVALID_EMAIL: 2,
  WEAK_PASSWORD: 2,
  INVALID_DISPLAY_NAME: 2,
  EMAIL_ALREADY_REGISTERED: 4,
  MISSING_CONFIGURATION: 5,
  INCOMPATIBLE_SCHEMA: 6,
  TAXONOMY_UNAVAILABLE: 7,
  INVALID_CREDENTIAL_MATERIAL: 2,
  BOOTSTRAP_INPUT_UNAVAILABLE: 2,
  INVALID_INSTALLATION_LINEAGE: 2,
  FRESH_INSTALL_EVIDENCE_VETO: 8,
  FRESH_INSTALL_SEED_MISMATCH: 8,
  BOOTSTRAP_TRANSACTION_FAILED: 1,
};

export class FirstAdminBootstrapError extends Error {
  readonly exitCode: number;

  constructor(public readonly code: FirstAdminBootstrapCode, message: string) {
    super(message);
    this.name = "FirstAdminBootstrapError";
    this.exitCode = BOOTSTRAP_EXIT_CODES[code];
  }
}

export interface FirstAdminBootstrapStatus {
  eligible: boolean;
  existingUserId?: number;
  completedAt?: string;
}

export interface FirstAdminBootstrapResult {
  userId: number;
  assignmentId: number;
  bootstrappedAt: string;
}

export type SetupLineage = "FRESH" | "LEGACY";

export interface FirstAdminSetupPreview {
  lineage: SetupLineage;
  eligible: boolean;
  evidence: Record<string, number>;
  retirement_divisions: Array<{ code: string; name: string }>;
  retirement_rule: Record<string, unknown> | null;
}

export interface FirstAdminSetupDivision { code: string; name: string }

export interface FirstAdminProvisioningResult extends FirstAdminBootstrapResult { divisionCode: string }

export interface FirstAdminBootstrapInput {
  displayName: string;
  email: string;
  passwordAlgorithm: "scrypt";
  passwordHash: string;
}

export interface FirstAdminBootstrapRepository {
  getStatus(): Promise<FirstAdminBootstrapStatus>;
  bootstrap(input: FirstAdminBootstrapInput): Promise<FirstAdminBootstrapResult>;
  preview?(lineage: SetupLineage): Promise<FirstAdminSetupPreview>;
  resolveActiveDivision?(code: string): Promise<FirstAdminSetupDivision | null>;
  provision?(input: FirstAdminBootstrapInput & { lineage: SetupLineage; divisionCode: string; divisionName: string }): Promise<FirstAdminProvisioningResult>;
}

interface BootstrapRow {
  user_id: number;
  assignment_id: number;
  bootstrapped_at: string;
}

interface ProvisioningRow extends BootstrapRow { division_code: string }

function mapDatabaseDiagnostic(error: DatabaseDiagnostic): FirstAdminBootstrapError {
  const message = error.message ?? "";
  if (message.includes("FIRST_ADMIN_ALREADY_EXISTS")
    || (error.code === "23505" && message.includes("instance_bootstrap_pkey"))) {
    return new FirstAdminBootstrapError("FIRST_ADMIN_ALREADY_EXISTS", "The first administrator has already been created");
  }
  if (error.code === "23505" && message.includes("admin_credentials_email_uidx")) {
    return new FirstAdminBootstrapError("EMAIL_ALREADY_REGISTERED", "That administrator email is already registered");
  }
  if (message.includes("TAXONOMY_UNAVAILABLE")) {
    return new FirstAdminBootstrapError("TAXONOMY_UNAVAILABLE", "Required administrative taxonomy is unavailable");
  }
  if (message.includes("INVALID_DISPLAY_NAME")) {
    return new FirstAdminBootstrapError("INVALID_DISPLAY_NAME", "Display name is invalid");
  }
  if (message.includes("INVALID_EMAIL")) {
    return new FirstAdminBootstrapError("INVALID_EMAIL", "Email address is invalid");
  }
  if (message.includes("INVALID_CREDENTIAL_MATERIAL")) {
    return new FirstAdminBootstrapError("INVALID_CREDENTIAL_MATERIAL", "Credential material is invalid");
  }
  if (message.includes("INVALID_INSTALLATION_LINEAGE")) {
    return new FirstAdminBootstrapError("INVALID_INSTALLATION_LINEAGE", "Installation lineage must be selected explicitly");
  }
  if (message.includes("FRESH_INSTALL_EVIDENCE_VETO")) {
    return new FirstAdminBootstrapError("FRESH_INSTALL_EVIDENCE_VETO", "Existing installation evidence blocks fresh taxonomy retirement");
  }
  if (message.includes("FRESH_INSTALL_SEED_MISMATCH") || message.includes("FRESH_INSTALL_REFERENCE_VETO")
    || message.includes("FRESH_INSTALL_AUDIT_VETO") || message.includes("FRESH_INSTALL_RETIREMENT_FAILED")) {
    return new FirstAdminBootstrapError("FRESH_INSTALL_SEED_MISMATCH", "Origin taxonomy does not exactly match the safe retirement set");
  }
  if (["PGRST202", "PGRST205", "42883", "42P01"].includes(error.code ?? "")) {
    return new FirstAdminBootstrapError("INCOMPATIBLE_SCHEMA", "First-administrator schema is unavailable; apply migrations first");
  }
  return new FirstAdminBootstrapError("BOOTSTRAP_TRANSACTION_FAILED", "First-administrator bootstrap transaction failed");
}

export class SupabaseFirstAdminBootstrapRepository implements FirstAdminBootstrapRepository {
  constructor(private readonly client: SupabaseClient) {}

  async getStatus(): Promise<FirstAdminBootstrapStatus> {
    const marker = await this.client.from("instance_bootstrap")
      .select("first_admin_user_id,completed_at").limit(1).maybeSingle();
    if (marker.error) throw mapDatabaseDiagnostic(marker.error);
    if (marker.data) {
      return {
        eligible: false,
        existingUserId: Number(marker.data.first_admin_user_id),
        completedAt: String(marker.data.completed_at),
      };
    }

    const [assignments, credentials] = await Promise.all([
      this.client.from("system_authority_assignments").select("id", { count: "exact", head: true }),
      this.client.from("admin_credentials").select("user_id", { count: "exact", head: true }),
    ]);
    if (assignments.error) throw mapDatabaseDiagnostic(assignments.error);
    if (credentials.error) throw mapDatabaseDiagnostic(credentials.error);
    return { eligible: (assignments.count ?? 0) === 0 && (credentials.count ?? 0) === 0 };
  }

  async bootstrap(input: FirstAdminBootstrapInput): Promise<FirstAdminBootstrapResult> {
    const { data, error } = await this.client.rpc("bootstrap_first_admin", {
      p_display_name: input.displayName,
      p_email: input.email,
      p_password_algorithm: input.passwordAlgorithm,
      p_password_hash: input.passwordHash,
    }).single();
    if (error) throw mapDatabaseDiagnostic(error);
    const row = data as BootstrapRow;
    return { userId: Number(row.user_id), assignmentId: Number(row.assignment_id), bootstrappedAt: row.bootstrapped_at };
  }

  async preview(lineage: SetupLineage): Promise<FirstAdminSetupPreview> {
    const { data, error } = await this.client.rpc("preview_first_admin_setup", { p_lineage: lineage });
    if (error) throw mapDatabaseDiagnostic(error);
    return data as FirstAdminSetupPreview;
  }

  async resolveActiveDivision(code: string): Promise<FirstAdminSetupDivision | null> {
    const { data, error } = await this.client.from("divisions").select("code,name")
      .eq("code", code).eq("active", true).maybeSingle();
    if (error) throw mapDatabaseDiagnostic(error);
    return data as FirstAdminSetupDivision | null;
  }

  async provision(input: FirstAdminBootstrapInput & { lineage: SetupLineage; divisionCode: string; divisionName: string }): Promise<FirstAdminProvisioningResult> {
    const { data, error } = await this.client.rpc("provision_first_installation", {
      p_display_name: input.displayName, p_email: input.email,
      p_password_algorithm: input.passwordAlgorithm, p_password_hash: input.passwordHash,
      p_lineage: input.lineage, p_division_code: input.divisionCode, p_division_name: input.divisionName,
    }).single();
    if (error) throw mapDatabaseDiagnostic(error);
    const row = data as ProvisioningRow;
    return { userId: Number(row.user_id), assignmentId: Number(row.assignment_id),
      bootstrappedAt: row.bootstrapped_at, divisionCode: row.division_code };
  }
}

export function asFirstAdminBootstrapError(error: unknown): FirstAdminBootstrapError {
  if (error instanceof FirstAdminBootstrapError) return error;
  if (error instanceof DatabaseError) return mapDatabaseDiagnostic(error.diagnostic);
  return new FirstAdminBootstrapError("BOOTSTRAP_TRANSACTION_FAILED", "First-administrator bootstrap failed");
}
