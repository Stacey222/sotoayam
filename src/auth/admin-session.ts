import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AdminSessionRepository } from "../repositories/admin-session.repository.js";

const SECURE_SESSION_COOKIE = "__Host-sotoayam_session";
const SECURE_CSRF_COOKIE = "__Host-sotoayam_csrf";
const INSECURE_SESSION_COOKIE = "sotoayam_session";
const INSECURE_CSRF_COOKIE = "sotoayam_csrf";
export const CSRF_HEADER = "x-csrf-token";

export interface SessionPrincipal {
  readonly kind: "session";
  readonly adminUserId: number;
  readonly sessionId: string;
  readonly email: string;
  readonly displayName: string;
  readonly expiresAt: string;
}

export interface AdminSessionAuthenticator {
  authenticate(request: FastifyRequest): Promise<SessionPrincipal | null>;
  verifyCsrf(request: FastifyRequest, principal: SessionPrincipal): boolean;
}

export function generateOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function digestUserAgent(value: string | undefined): string | null {
  return value ? createHash("sha256").update(value, "utf8").digest("hex") : null;
}

function cookieNames(secure: boolean) {
  return secure
    ? { session: SECURE_SESSION_COOKIE, csrf: SECURE_CSRF_COOKIE }
    : { session: INSECURE_SESSION_COOKIE, csrf: INSECURE_CSRF_COOKIE };
}

export function setAdminSessionCookies(reply: FastifyReply, secure: boolean, sessionToken: string, csrfToken: string): void {
  const names = cookieNames(secure);
  const common = { path: "/", secure, sameSite: "strict" as const };
  reply.setCookie(names.session, sessionToken, { ...common, httpOnly: true });
  reply.setCookie(names.csrf, csrfToken, { ...common, httpOnly: false });
}

export function clearAdminSessionCookies(reply: FastifyReply, secure: boolean): void {
  const names = cookieNames(secure);
  const common = { path: "/", secure, sameSite: "strict" as const, maxAge: 0 };
  reply.clearCookie(names.session, { ...common, httpOnly: true });
  reply.clearCookie(names.csrf, { ...common, httpOnly: false });
}

function constantTimeHashMatch(raw: string, expectedHex: string): boolean {
  const actual = Buffer.from(hashOpaqueToken(raw), "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class DatabaseAdminSessionAuthenticator implements AdminSessionAuthenticator {
  private readonly csrfHashes = new WeakMap<SessionPrincipal, string>();

  constructor(private readonly repository: AdminSessionRepository, private readonly secure: boolean,
    private readonly idleTimeoutSeconds: number) {}

  async authenticate(request: FastifyRequest): Promise<SessionPrincipal | null> {
    const raw = request.cookies[cookieNames(this.secure).session];
    if (!raw || typeof raw !== "string") return null;
    const session = await this.repository.validateSession(hashOpaqueToken(raw), this.idleTimeoutSeconds);
    if (!session) return null;
    const principal: SessionPrincipal = { kind: "session", adminUserId: session.userId, sessionId: session.sessionId,
      email: session.email, displayName: session.displayName, expiresAt: session.expiresAt,
    };
    this.csrfHashes.set(principal, session.csrfTokenHash);
    return principal;
  }

  verifyCsrf(request: FastifyRequest, principal: SessionPrincipal): boolean {
    const header = request.headers[CSRF_HEADER];
    const expectedHash = this.csrfHashes.get(principal);
    return typeof header === "string" && typeof expectedHash === "string"
      && constantTimeHashMatch(header, expectedHash);
  }
}
