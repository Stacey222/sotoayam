import type { FastifyInstance, FastifyRequest } from "fastify";
import { clearAdminSessionCookies, setAdminSessionCookies, type AdminSessionAuthenticator,
  type SessionPrincipal } from "../auth/admin-session.js";
import { AppError } from "../errors.js";
import { AdminAuthenticationService, LoginThrottledError } from "../services/admin-authentication.service.js";

export const ADMIN_AUTH_ROUTE_SCOPE = Symbol.for("sotoayam.adminAuthRouteScope");

export interface AdminAuthRoutesOptions {
  service: AdminAuthenticationService;
  authenticator: AdminSessionAuthenticator;
  cookieSecure: boolean;
}

function sessionData(principal: SessionPrincipal) {
  return { user_id: principal.adminUserId, email: principal.email,
    display_name: principal.displayName, expires_at: principal.expiresAt };
}

async function authenticate(request: FastifyRequest, reply: import("fastify").FastifyReply,
  options: AdminAuthRoutesOptions): Promise<SessionPrincipal> {
  const principal = await options.authenticator.authenticate(request);
  if (!principal) throw new AppError(401, "SESSION_REQUIRED", "An authenticated administrator session is required");
  request.adminPrincipal = principal;
  request.server.rateLimitAdminIdentity?.(request, reply, principal);
  return principal;
}

function requireCsrf(request: FastifyRequest, options: AdminAuthRoutesOptions, principal: SessionPrincipal): void {
  if (!options.authenticator.verifyCsrf(request, principal)) {
    throw new AppError(403, "CSRF_INVALID", "A valid CSRF token is required");
  }
}

export const adminAuthRoutes = async (app: FastifyInstance, options: AdminAuthRoutesOptions): Promise<void> => {
  if (!app.hasRequestDecorator("adminPrincipal")) app.decorateRequest("adminPrincipal", null);

  app.post("/login", { config: { rateLimit: "login" } }, async (request, reply) => {
    const body = request.body as { email?: unknown; password?: unknown } | null;
    try {
      const result = await options.service.login({ email: body?.email, password: body?.password,
        clientIp: request.ip, userAgent: request.headers["user-agent"] });
      setAdminSessionCookies(reply, options.cookieSecure, result.sessionToken, result.csrfToken);
      return { success: true, data: sessionData(result.principal) };
    } catch (error) {
      if (error instanceof LoginThrottledError) reply.header("Retry-After", String(error.retryAfterSeconds));
      throw error;
    }
  });

  app.post("/logout", { config: { rateLimit: "auth-mutate" } }, async (request, reply) => {
    const principal = await options.authenticator.authenticate(request);
    if (principal) {
      request.server.rateLimitAdminIdentity?.(request, reply, principal);
      requireCsrf(request, options, principal);
      await options.service.logout(principal);
    }
    clearAdminSessionCookies(reply, options.cookieSecure);
    return reply.status(204).send();
  });

  app.get("/session", { config: { rateLimit: "auth-session" } }, async (request, reply) => {
    const principal = await authenticate(request, reply, options);
    return { success: true, data: sessionData(principal) };
  });

  app.post("/password", { config: { rateLimit: "auth-password" } }, async (request, reply) => {
    const principal = await authenticate(request, reply, options);
    requireCsrf(request, options, principal);
    const body = request.body as { current_password?: unknown; new_password?: unknown } | null;
    await options.service.changePassword(principal, {
      currentPassword: body?.current_password, newPassword: body?.new_password,
    });
    return reply.status(204).send();
  });

  app.get("/sessions", { config: { rateLimit: "auth-session" } }, async (request, reply) => {
    const principal = await authenticate(request, reply, options);
    const sessions = await options.service.listSessions(principal);
    return { success: true, data: sessions.map((session) => ({ ...session,
      current: session.sessionId === principal.sessionId })) };
  });

  app.delete<{ Params: { id: string } }>("/sessions/:id", { config: { rateLimit: "auth-mutate" } }, async (request, reply) => {
    const principal = await authenticate(request, reply, options);
    requireCsrf(request, options, principal);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.params.id)) {
      throw new AppError(400, "INVALID_SESSION_ID", "Session id is invalid");
    }
    await options.service.revokeOwnSession(principal, request.params.id);
    return reply.status(204).send();
  });
};

Object.defineProperty(adminAuthRoutes, ADMIN_AUTH_ROUTE_SCOPE, { value: true, enumerable: false });
