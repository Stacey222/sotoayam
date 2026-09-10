import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from "fastify";
import { ADMIN_API_KEY_HEADER, type AdminPrincipal } from "../auth/admin-authorization.js";
import type { AppConfig } from "../config/env.js";
import { RateLimitedError } from "../errors.js";
import { TokenBucketLimiter, type TokenBucketPolicy, type TokenBucketResult } from "./rate-limit.js";
import { createRateLimitPolicies, isIdentityPolicy, normalizeIp, type ConcretePolicyName,
  type RateLimitPolicyName } from "./rate-limit-policy.js";

interface RateLimiter {
  consume(key: string, policy: TokenBucketPolicy, cost?: number): TokenBucketResult;
  inspect(key: string, policy: TokenBucketPolicy, cost?: number): TokenBucketResult;
  sweep(): number;
  clear(): void;
}
export interface RateLimitManifestEntry { method: string; url: string; policy: RateLimitPolicyName }
export interface RateLimitPluginOptions { config: AppConfig; limiter?: RateLimiter; sweepIntervalMs?: number }

declare module "fastify" {
  interface FastifyInstance {
    rateLimitAdminIdentity?: (request: FastifyRequest, reply: FastifyReply, principal: AdminPrincipal) => void;
    rateLimitIntegrationIdentity?: (request: FastifyRequest, integrationId: number) => void;
    rateLimitRouteManifest?: RateLimitManifestEntry[];
    rateLimitTimerActive?: boolean;
    rateLimitTimerReferenced?: boolean;
  }
  interface FastifyRequest { rateLimitPolicy?: RateLimitPolicyName; rateLimitTrusted?: boolean }
}

const CREDENTIAL_POLICIES = new Set<RateLimitPolicyName>([
  "login", "auth-password", "auth-session", "auth-mutate", "admin-read", "admin-write", "admin-expensive", "internal",
]);

export async function registerRateLimit(app: FastifyInstance, options: RateLimitPluginOptions): Promise<void> {
  if (!options.config.rateLimitEnabled) return;
  const resolved = createRateLimitPolicies(options.config);
  const sampled = new Map<string, number>();
  const sample = (level: "warn" | "error", name: string, details: Record<string, unknown>, message: string) => {
    const now = Date.now();
    if (now - (sampled.get(`${level}:${name}`) ?? 0) < 10_000) return;
    sampled.set(`${level}:${name}`, now);
    app.log[level](details, message);
  };
  const limiter = options.limiter ?? new TokenBucketLimiter(options.config.rateLimitMaxKeys, Date.now,
    () => sample("warn", "capacity", {}, "Rate limiter key capacity reached"));
  // The keyless backstop has its own one-key limiter, so attacker-created key
  // pressure cannot evict or reset the global login budget.
  const globalLoginLimiter = new TokenBucketLimiter(1);
  const manifest: RateLimitManifestEntry[] = [];
  app.decorate("rateLimitRouteManifest", manifest);
  app.decorate("rateLimitTimerActive", true);

  const scaledForIp = (policy: TokenBucketPolicy): TokenBucketPolicy => resolved.sharedOrigin
    ? { ...policy, capacity: policy.capacity * options.config.rateLimitSharedOriginFactor }
    : policy;
  const requestIpKey = (request: FastifyRequest) => `ip:${normalizeIp(request.ip)}`;
  const hasAdminApiKey = (request: FastifyRequest) => request.headers[ADMIN_API_KEY_HEADER] !== undefined;
  const isTrusted = (request: FastifyRequest) => resolved.trustedIps.has(normalizeIp(request.ip)) && !hasAdminApiKey(request);
  const reject = (policy: ConcretePolicyName, result: TokenBucketResult,
    keyClass: "ip" | "session" | "apikey", expose: boolean): never => {
    sample("warn", policy, { policy, keyClass }, "Request rate limited");
    const details = expose
      ? { limit: resolved.policies[policy].capacity, remaining: result.remaining, resetSeconds: result.resetSeconds }
      : undefined;
    throw new RateLimitedError(result.retryAfterSeconds, details);
  };
  const safe = <T>(operation: () => T): T | null => {
    try { return operation(); }
    catch (error) {
      sample("error", "internal", { errorType: error instanceof Error ? error.name : "UnknownError" },
        "Rate limiter failed open");
      return null;
    }
  };

  if (resolved.sharedOrigin) app.log.warn(
    "TRUST_PROXY=false on a loopback HOST collapses client IPs; shared-origin rate limits are active and TRUST_PROXY=true is required behind a trusted reverse proxy",
  );

  app.addHook("onRoute", (route: RouteOptions) => {
    // Encapsulated scopes stamp their policy in their own onRoute hook. Defer the
    // manifest snapshot until all hooks for this registration have completed.
    queueMicrotask(() => {
      const policy = route.config?.rateLimit ?? "default";
      for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
        manifest.push({ method, url: route.url, policy });
      }
    });
  });

  app.addHook("onRequest", async (request) => {
    const policy = request.routeOptions.config.rateLimit ?? "default";
    request.rateLimitPolicy = policy;
    request.rateLimitTrusted = isTrusted(request);
    if (policy === "exempt" || request.rateLimitTrusted) return;

    // A 401 charges this bucket in onResponse. Future credential attempts inspect it here,
    // without charging successful traffic; a limiter-generated 429 can therefore never
    // manufacture a P1-01 login failure or another auth-failure penalty.
    if (CREDENTIAL_POLICIES.has(policy)) {
      const penalty = safe(() => limiter.inspect(`auth-failure:${requestIpKey(request)}`,
        scaledForIp(resolved.policies["auth-failure"])));
      if (penalty && !penalty.allowed) reject("auth-failure", penalty, "ip", false);
    }
    const result = safe(() => limiter.consume(`${policy}:${requestIpKey(request)}`,
      scaledForIp(resolved.policies[policy])));
    if (result && !result.allowed) reject(policy, result, "ip", false);
    if (policy === "login") {
      const global = safe(() => globalLoginLimiter.consume("login:global", resolved.policies["login-global"]));
      if (global && !global.allowed) reject(policy, global, "ip", false);
    }
  });

  app.decorate("rateLimitAdminIdentity", (request: FastifyRequest, reply: FastifyReply, principal: AdminPrincipal) => {
    const policy = request.rateLimitPolicy ?? request.routeOptions.config.rateLimit ?? "default";
    if (!isIdentityPolicy(policy) || policy === "internal") return;
    const keyClass = principal.kind === "session" ? "session" : "apikey";
    const identity = principal.kind === "session"
      ? (policy === "auth-session" || policy === "auth-mutate" ? `session-id:${principal.sessionId}` : `session:${principal.adminUserId}`)
      : "apikey";
    const result = safe(() => limiter.consume(`${policy}:${identity}`, resolved.policies[policy]));
    if (!result) return;
    reply.headers({ "RateLimit-Limit": String(resolved.policies[policy].capacity),
      "RateLimit-Remaining": String(result.remaining), "RateLimit-Reset": String(result.resetSeconds) });
    if (!result.allowed) reject(policy, result, keyClass, true);
  });

  app.decorate("rateLimitIntegrationIdentity", (request: FastifyRequest, integrationId: number) => {
    if (request.rateLimitTrusted) return;
    const result = safe(() => limiter.consume(`internal:integration:${integrationId}`, resolved.policies.internal));
    if (result && !result.allowed) reject("internal", result, "session", false);
  });

  app.addHook("onResponse", async (request, reply) => {
    if (reply.statusCode !== 401 || request.rateLimitPolicy === "exempt" || request.rateLimitTrusted) return;
    safe(() => limiter.consume(`auth-failure:${requestIpKey(request)}`,
      scaledForIp(resolved.policies["auth-failure"])));
  });

  const timer = setInterval(() => { safe(() => limiter.sweep()); safe(() => globalLoginLimiter.sweep()); },
    options.sweepIntervalMs ?? 60_000);
  timer.unref();
  app.decorate("rateLimitTimerReferenced", timer.hasRef());
  app.addHook("onClose", async () => {
    clearInterval(timer);
    limiter.clear();
    globalLoginLimiter.clear();
    app.rateLimitTimerActive = false;
  });
}
