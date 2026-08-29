export interface GovernanceCatalogEntry {
  id: number;
  code: string;
  name: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Division extends GovernanceCatalogEntry {}
export interface Role extends GovernanceCatalogEntry {}
export interface Permission extends GovernanceCatalogEntry {}

export interface SystemAuthorityAssignment {
  id: number;
  user_id: number;
  authority_code: "SYSTEM_ADMIN";
  granted_at: string;
  granted_by_user_id: number | null;
  revoked_at: string | null;
  revoked_by_user_id: number | null;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type AuditState = Record<string, JsonValue>;

export interface AuditLogInput {
  actor_type: "USER" | "SYSTEM";
  actor_user_id?: number | null;
  action: string;
  object_type: string;
  object_id: string;
  before_state?: unknown;
  after_state?: unknown;
  source: string;
}

export interface AuditLog extends Omit<AuditLogInput, "before_state" | "after_state"> {
  id: number;
  before_state: AuditState | null;
  after_state: AuditState | null;
  created_at: string;
}
