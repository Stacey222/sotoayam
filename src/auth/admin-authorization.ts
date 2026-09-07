import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppError } from "../errors.js";
import { secureEqual } from "../security.js";

export const ADMIN_API_KEY_HEADER = "x-admin-api-key";
export const DEFAULT_ADMIN_UNAUTHORIZED_MESSAGE = "Invalid or missing admin API key";

/** Marks a plugin produced by defineAdminRoutes so tests can assert protection structurally. */
export const ADMIN_ROUTE_SCOPE = Symbol.for("sotoayam.adminRouteScope");

/**
 * The authenticated admin principal.
 * Phase 1 (P1-01) extends this with real identity (adminUserId, roles, sessionId)
 * and adds a "session" kind. Route bodies read this, never the header.
 */
export interface AdminPrincipal {
  readonly kind: "shared-api-key";
}

/** Options every admin route group must accept. Optional at the type level so existing call
 * sites and the SEC-001 regression table compile unchanged; absence is denied at runtime. */
export interface AdminAuthorizedRouteOptions {
  adminApiKey?: string;
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
export function resolveAdminPrincipal(
  request: FastifyRequest,
  options: AdminAuthorizedRouteOptions,
  settings: AdminRouteScopeSettings = {},
): AdminPrincipal {
  const configuredKey = options.adminApiKey;
  const providedKey = request.headers[ADMIN_API_KEY_HEADER];
  if (!configuredKey || typeof providedKey !== "string" || !secureEqual(providedKey, configuredKey)) {
    throw new AppError(401, "UNAUTHORIZED",
      settings.unauthorizedMessage ?? DEFAULT_ADMIN_UNAUTHORIZED_MESSAGE);
  }
  return { kind: "shared-api-key" };
}

/** Wraps a route body in an encapsulated, admin-authorized Fastify scope. */
export function defineAdminRoutes<Options extends AdminAuthorizedRouteOptions>(
  routes: (app: FastifyInstance, options: Options) => Promise<void>,
  settings: AdminRouteScopeSettings = {},
): (app: FastifyInstance, options: Options) => Promise<void> {
  const scope = async (app: FastifyInstance, options: Options): Promise<void> => {
    if (!app.hasRequestDecorator("adminPrincipal")) app.decorateRequest("adminPrincipal", null);
    app.addHook("preHandler", async (request) => {
      request.adminPrincipal = resolveAdminPrincipal(request, options, settings);
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
