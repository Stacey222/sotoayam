import type { SupabaseClient } from "@supabase/supabase-js";
import { governanceDatabaseError } from "./governance-database-error.js";

export type LoginFailureReason = "UNKNOWN_EMAIL" | "BAD_PASSWORD" | "INACTIVE_USER" | "LOCKED_OUT";
export type SessionRevocationReason = "LOGOUT" | "PASSWORD_CHANGED" | "REVOKED_BY_ADMIN";

export interface AdminCredentialRecord {
  userId: number;
  email: string;
  displayName: string;
  active: boolean;
  passwordAlgorithm: "scrypt";
  passwordHash: string;
}

export interface AdminSessionRecord {
  sessionId: string;
  userId: number;
  email: string;
  displayName: string;
  expiresAt: string;
  csrfTokenHash: string;
}

export interface AdminSessionSummary {
  sessionId: string;
  issuedAt: string;
  expiresAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
  clientIp: string | null;
  userAgentDigest: string | null;
}

export interface AdminSessionRepository {
  findCredentialByEmail(email: string): Promise<AdminCredentialRecord | null>;
  findCredentialByUserId(userId: number): Promise<AdminCredentialRecord | null>;
  evaluateLoginGate(userId: number | null, clientIp: string | null): Promise<{ locked: boolean; retryAfterSeconds: number }>;
  recordLoginFailure(userId: number | null, clientIp: string | null, reason: LoginFailureReason): Promise<void>;
  createSession(input: { userId: number; tokenHash: string; csrfTokenHash: string; absoluteTtlSeconds: number;
    clientIp: string | null; userAgentDigest: string | null }): Promise<{ sessionId: string; issuedAt: string; expiresAt: string }>;
  validateSession(tokenHash: string, idleTimeoutSeconds: number): Promise<AdminSessionRecord | null>;
  revokeSession(sessionId: string, reason: Extract<SessionRevocationReason, "LOGOUT" | "REVOKED_BY_ADMIN">, actorUserId: number): Promise<boolean>;
  revokeSessionsForUser(userId: number, reason: Extract<SessionRevocationReason, "PASSWORD_CHANGED" | "REVOKED_BY_ADMIN">,
    actorUserId: number, exceptSessionId?: string | null): Promise<number>;
  changePassword(userId: number, algorithm: "scrypt", hash: string, actorUserId: number, keepSessionId?: string | null): Promise<void>;
  listSessions(userId: number): Promise<AdminSessionSummary[]>;
}

interface CredentialRow {
  user_id: number;
  email: string;
  password_algorithm: "scrypt";
  password_hash: string;
  users: { display_name: string; active: boolean } | Array<{ display_name: string; active: boolean }> | null;
}

function relatedUser(row: CredentialRow): { display_name: string; active: boolean } | null {
  return Array.isArray(row.users) ? (row.users[0] ?? null) : row.users;
}

function firstRow<T>(data: unknown): T | null {
  if (Array.isArray(data)) return (data[0] as T | undefined) ?? null;
  return data && typeof data === "object" ? data as T : null;
}

export class SupabaseAdminSessionRepository implements AdminSessionRepository {
  constructor(private readonly client: SupabaseClient) {}

  private async credential(field: "email" | "user_id", value: string | number): Promise<AdminCredentialRecord | null> {
    const { data, error } = await this.client.from("admin_credentials")
      .select("user_id,email,password_algorithm,password_hash,users!inner(display_name,active)")
      .eq(field, value)
      .limit(1).maybeSingle();
    if (error) throw governanceDatabaseError("Unable to load administrator credential", error);
    if (!data) return null;
    const row = data as unknown as CredentialRow;
    const user = relatedUser(row);
    if (!user) return null;
    return { userId: Number(row.user_id), email: row.email, displayName: user.display_name,
      active: user.active, passwordAlgorithm: row.password_algorithm, passwordHash: row.password_hash };
  }

  findCredentialByEmail(email: string): Promise<AdminCredentialRecord | null> {
    return this.credential("email", email);
  }

  findCredentialByUserId(userId: number): Promise<AdminCredentialRecord | null> {
    return this.credential("user_id", userId);
  }

  async evaluateLoginGate(userId: number | null, clientIp: string | null) {
    const { data, error } = await this.client.rpc("evaluate_admin_login_gate", { p_user_id: userId, p_client_ip: clientIp });
    if (error) throw governanceDatabaseError("Unable to evaluate administrator login gate", error);
    const row = firstRow<{ locked: boolean; retry_after_seconds: number }>(data);
    return { locked: row?.locked === true, retryAfterSeconds: Number(row?.retry_after_seconds ?? 0) };
  }

  async recordLoginFailure(userId: number | null, clientIp: string | null, reason: LoginFailureReason): Promise<void> {
    const { error } = await this.client.rpc("record_admin_login_failure", { p_user_id: userId, p_client_ip: clientIp, p_reason: reason });
    if (error) throw governanceDatabaseError("Unable to record administrator login failure", error);
  }

  async createSession(input: { userId: number; tokenHash: string; csrfTokenHash: string; absoluteTtlSeconds: number;
    clientIp: string | null; userAgentDigest: string | null }) {
    const { data, error } = await this.client.rpc("create_admin_session", {
      p_user_id: input.userId, p_token_hash: input.tokenHash, p_csrf_token_hash: input.csrfTokenHash,
      p_absolute_ttl_seconds: input.absoluteTtlSeconds, p_client_ip: input.clientIp,
      p_user_agent_digest: input.userAgentDigest,
    });
    if (error) throw governanceDatabaseError("Unable to create administrator session", error);
    const row = firstRow<{ session_id: string; issued_at: string; expires_at: string }>(data);
    if (!row) throw new Error("Administrator session creation returned no row");
    return { sessionId: row.session_id, issuedAt: row.issued_at, expiresAt: row.expires_at };
  }

  async validateSession(tokenHash: string, idleTimeoutSeconds: number): Promise<AdminSessionRecord | null> {
    const { data, error } = await this.client.rpc("validate_admin_session", {
      p_token_hash: tokenHash, p_idle_timeout_seconds: idleTimeoutSeconds, p_touch_after_seconds: 60,
    });
    if (error) throw governanceDatabaseError("Unable to validate administrator session", error);
    const row = firstRow<{ session_id: string; user_id: number; email: string; display_name: string;
      expires_at: string; csrf_token_hash: string }>(data);
    return row ? { sessionId: row.session_id, userId: Number(row.user_id), email: row.email,
      displayName: row.display_name, expiresAt: row.expires_at, csrfTokenHash: row.csrf_token_hash } : null;
  }

  async revokeSession(sessionId: string, reason: "LOGOUT" | "REVOKED_BY_ADMIN", actorUserId: number): Promise<boolean> {
    const { data, error } = await this.client.rpc("revoke_admin_session", {
      p_session_id: sessionId, p_reason: reason, p_actor_user_id: actorUserId,
    });
    if (error) throw governanceDatabaseError("Unable to revoke administrator session", error);
    return data === true;
  }

  async revokeSessionsForUser(userId: number, reason: "PASSWORD_CHANGED" | "REVOKED_BY_ADMIN",
    actorUserId: number, exceptSessionId: string | null = null): Promise<number> {
    const { data, error } = await this.client.rpc("revoke_admin_sessions_for_user", {
      p_user_id: userId, p_reason: reason, p_actor_user_id: actorUserId, p_except_session_id: exceptSessionId,
    });
    if (error) throw governanceDatabaseError("Unable to revoke administrator sessions", error);
    return Number(data ?? 0);
  }

  async changePassword(userId: number, algorithm: "scrypt", hash: string, actorUserId: number,
    keepSessionId: string | null = null): Promise<void> {
    const { error } = await this.client.rpc("change_admin_password", {
      p_user_id: userId, p_algorithm: algorithm, p_hash: hash,
      p_actor_user_id: actorUserId, p_keep_session_id: keepSessionId,
    });
    if (error) throw governanceDatabaseError("Unable to change administrator password", error);
  }

  async listSessions(userId: number): Promise<AdminSessionSummary[]> {
    const { data, error } = await this.client.rpc("list_admin_sessions", { p_user_id: userId });
    if (error) throw governanceDatabaseError("Unable to list administrator sessions", error);
    return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      sessionId: String(row.session_id), issuedAt: String(row.issued_at), expiresAt: String(row.expires_at),
      lastSeenAt: String(row.last_seen_at), revokedAt: row.revoked_at ? String(row.revoked_at) : null,
      revokedReason: row.revoked_reason ? String(row.revoked_reason) : null,
      clientIp: row.client_ip ? String(row.client_ip) : null,
      userAgentDigest: row.user_agent_digest ? String(row.user_agent_digest) : null,
    }));
  }
}
