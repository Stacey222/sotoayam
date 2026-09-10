import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppError } from "../errors.js";
import { secureEqual } from "../security.js";
import type { AdminSessionAuthenticator, SessionPrincipal } from "./admin-session.js";
import { defaultAdminPolicy } from "../http/rate-limit-policy.js";

export const ADMIN_API_KEY_HEADER = "x-admin-api-key";
export const DEFAULT_ADMIN_UNAUTHORIZED_MESSAGE = "Invalid or missing admin API key";

/** Marks a plugin produced by defineAdminRoutes so tests can assert protection structurally. */
export const ADMIN_ROUTE_SCOPE = Symbol.for("sotoayam.adminRouteScope");

export type AdminPrincipal = SessionPrincipal | { readonly kind: "shared-api-key" };

/** Options every admin route group must accept. Optional at the type level so existing call
 * sites and the SEC-001 regression table compile unchanged; absence is denied at runtime. */
export interface AdminAuthorizedRouteOptions {
  adminApiKey?: string;
  adminApiKeyFallbackEnabled?: boolean;
  sessionAuthenticator?: AdminSessionAuthenticator;
  onApiKeyFallback?: () => void | Promise<void>;
}

export interface AdminRouteScopeSettings {
  /** Preserves per-group 401 wording, e.g. "Invalid or missing report API key". */
  unauthorizedMessage?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Present only inside an admin route scope; set by the shared guard. */
    adminPrincipal?: AdminPrincipal | null;
  }
}

/** The single implementation of admin credential validation. Fail-closed by construction. */
export async function resolveAdminPrincipal(
  request: FastifyRequest,
  options: AdminAuthorizedRouteOptions,
  settings: AdminRouteScopeSettings = {},
): Promise<AdminPrincipal> {
  const session = await options.sessionAuthenticator?.authenticate(request);
  if (session) return session;
  const configuredKey = options.adminApiKey;
  const providedKey = request.headers[ADMIN_API_KEY_HEADER];
  if (options.adminApiKeyFallbackEnabled === false || !configuredKey
    || typeof providedKey !== "string" || !secureEqual(providedKey, configuredKey)) {
    throw new AppError(401, "UNAUTHORIZED",
      settings.unauthorizedMessage ?? DEFAULT_ADMIN_UNAUTHORIZED_MESSAGE);
  }
  await options.onApiKeyFallback?.();
  return { kind: "shared-api-key" };
}

export function requireSessionPrincipal(request: FastifyRequest): SessionPrincipal {
  if (request.adminPrincipal?.kind !== "session") {
    throw new AppError(401, "SESSION_REQUIRED", "An authenticated administrator session is required");
  }
  return request.adminPrincipal;
}

/** Wraps a route body in an encapsulated, admin-authorized Fastify scope. */
export function defineAdminRoutes<Options extends AdminAuthorizedRouteOptions>(
  routes: (app: FastifyInstance, options: Options) => Promise<void>,
  settings: AdminRouteScopeSettings = {},
): (app: FastifyInstance, options: Options) => Promise<void> {
  const scope = async (app: FastifyInstance, options: Options): Promise<void> => {
    if (!app.hasRequestDecorator("adminPrincipal")) app.decorateRequest("adminPrincipal", null);
    app.addHook("onRoute", (routeOptions) => {
      routeOptions.config = { ...routeOptions.config,
        rateLimit: routeOptions.config?.rateLimit ?? defaultAdminPolicy(routeOptions.method) };
    });
    app.addHook("preHandler", async (request, reply) => {
      request.adminPrincipal = await resolveAdminPrincipal(request, options, settings);
      app.rateLimitAdminIdentity?.(request, reply, request.adminPrincipal);
      if (request.adminPrincipal.kind === "session" && !["GET", "HEAD", "OPTIONS"].includes(request.method)
        && !options.sessionAuthenticator?.verifyCsrf(request, request.adminPrincipal)) {
        throw new AppError(403, "CSRF_INVALID", "A valid CSRF token is required");
      }
    });
    await routes(app, options);
  };
  Object.defineProperty(scope, ADMIN_ROUTE_SCOPE, { value: true, enumerable: false });
  return scope;
}

export function isAdminRouteScope(plugin: unknown): boolean {
  return typeof plugin === "function"
    && (plugin as unknown as Record<symbol, unknown>)[ADMIN_ROUTE_SCOPE] === true;
}
