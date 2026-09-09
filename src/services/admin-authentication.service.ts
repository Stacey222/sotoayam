import { AppError } from "../errors.js";
import { hashPassword, validatePasswordPolicy, verifyPassword } from "../auth/admin-password.js";
import { digestUserAgent, generateOpaqueToken, hashOpaqueToken, type SessionPrincipal } from "../auth/admin-session.js";
import type { AuditRepository } from "../repositories/audit.repository.js";
import type { AdminSessionRepository, LoginFailureReason } from "../repositories/admin-session.repository.js";

const DUMMY_PASSWORD_HASH = hashPassword("sotoayam-dummy-login-password-value");
const INVALID_CREDENTIALS_MESSAGE = "Invalid email or password";

export class LoginThrottledError extends AppError {
  constructor(readonly retryAfterSeconds: number) {
    super(429, "LOGIN_THROTTLED", "Login temporarily throttled; try again later");
  }
}

export interface AdminLoginResult {
  principal: SessionPrincipal;
  sessionToken: string;
  csrfToken: string;
}

export class AdminAuthenticationService {
  private fallbackObservation?: Promise<void>;

  constructor(private readonly repository: AdminSessionRepository, private readonly absoluteTtlSeconds: number,
    private readonly audit?: AuditRepository, private readonly warn: (message: string) => void = () => undefined) {}

  async login(input: { email: unknown; password: unknown; clientIp: string; userAgent?: string }): Promise<AdminLoginResult> {
    const email = typeof input.email === "string" ? input.email.trim().toLocaleLowerCase("en-US") : "";
    const password = typeof input.password === "string" ? input.password : "";
    const credential = email ? await this.repository.findCredentialByEmail(email) : null;
    const gate = await this.repository.evaluateLoginGate(credential?.userId ?? null, input.clientIp || null);
    if (gate.locked) {
      await this.repository.recordLoginFailure(credential?.userId ?? null, input.clientIp || null, "LOCKED_OUT");
      throw new LoginThrottledError(gate.retryAfterSeconds);
    }

    const passwordMatches = await verifyPassword(password, credential?.passwordHash ?? await DUMMY_PASSWORD_HASH);
    let failure: LoginFailureReason | null = null;
    if (!credential) failure = "UNKNOWN_EMAIL";
    else if (!passwordMatches) failure = "BAD_PASSWORD";
    else if (!credential.active) failure = "INACTIVE_USER";
    if (failure) {
      await this.repository.recordLoginFailure(credential?.userId ?? null, input.clientIp || null, failure);
      throw new AppError(401, "INVALID_CREDENTIALS", INVALID_CREDENTIALS_MESSAGE);
    }
    if (!credential) throw new AppError(401, "INVALID_CREDENTIALS", INVALID_CREDENTIALS_MESSAGE);

    const sessionToken = generateOpaqueToken();
    const csrfToken = generateOpaqueToken();
    const created = await this.repository.createSession({
      userId: credential.userId,
      tokenHash: hashOpaqueToken(sessionToken),
      csrfTokenHash: hashOpaqueToken(csrfToken),
      absoluteTtlSeconds: this.absoluteTtlSeconds,
      clientIp: input.clientIp || null,
      userAgentDigest: digestUserAgent(input.userAgent),
    });
    return { sessionToken, csrfToken, principal: { kind: "session", adminUserId: credential.userId,
      sessionId: created.sessionId, email: credential.email, displayName: credential.displayName,
      expiresAt: created.expiresAt } };
  }

  async logout(principal: SessionPrincipal): Promise<void> {
    await this.repository.revokeSession(principal.sessionId, "LOGOUT", principal.adminUserId);
  }

  async changePassword(principal: SessionPrincipal, input: { currentPassword: unknown; newPassword: unknown }): Promise<void> {
    if (typeof input.currentPassword !== "string" || typeof input.newPassword !== "string") {
      throw new AppError(400, "INVALID_REQUEST", "Current and new passwords are required");
    }
    const credential = await this.repository.findCredentialByUserId(principal.adminUserId);
    if (!credential || !await verifyPassword(input.currentPassword, credential.passwordHash)) {
      throw new AppError(401, "INVALID_CREDENTIALS", INVALID_CREDENTIALS_MESSAGE);
    }
    try {
      validatePasswordPolicy(input.newPassword, { email: credential.email, displayName: credential.displayName });
    } catch {
      throw new AppError(400, "WEAK_PASSWORD", "Password does not meet the security policy");
    }
    const encoded = await hashPassword(input.newPassword);
    await this.repository.changePassword(principal.adminUserId, "scrypt", encoded,
      principal.adminUserId, principal.sessionId);
  }

  listSessions(principal: SessionPrincipal) {
    return this.repository.listSessions(principal.adminUserId);
  }

  async revokeOwnSession(principal: SessionPrincipal, sessionId: string): Promise<void> {
    await this.repository.revokeSession(sessionId, "REVOKED_BY_ADMIN", principal.adminUserId);
  }

  async resetPassword(emailInput: string, newPassword: string): Promise<void> {
    const email = emailInput.trim().toLocaleLowerCase("en-US");
    const credential = await this.repository.findCredentialByEmail(email);
    if (!credential) throw new AppError(404, "ADMIN_CREDENTIAL_NOT_FOUND", "Administrator credential was not found");
    try {
      validatePasswordPolicy(newPassword, { email: credential.email, displayName: credential.displayName });
    } catch {
      throw new AppError(400, "WEAK_PASSWORD", "Password does not meet the security policy");
    }
    const encoded = await hashPassword(newPassword);
    await this.repository.changePassword(credential.userId, "scrypt", encoded, credential.userId, null);
  }

  async observeApiKeyFallback(): Promise<void> {
    if (!this.fallbackObservation) this.fallbackObservation = (async () => {
      this.warn("ADMIN_API_KEY compatibility fallback used");
      await this.audit?.append({ actor_type: "SYSTEM", actor_user_id: null,
        action: "ADMIN_API_KEY_FALLBACK_USED", object_type: "ADMIN_SESSION", object_id: "PROCESS",
        before_state: null, after_state: { fallback: true }, source: "admin_session_api" });
    })();
    try {
      await this.fallbackObservation;
    } catch (error) {
      this.fallbackObservation = undefined;
      throw error;
    }
  }
}
