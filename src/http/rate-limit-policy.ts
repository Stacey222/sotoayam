import { isIP } from "node:net";
import type { AppConfig } from "../config/env.js";
import type { TokenBucketPolicy } from "./rate-limit.js";

export type RateLimitPolicyName = "exempt" | "login" | "auth-password" | "auth-session"
  | "auth-mutate" | "admin-read" | "admin-write" | "admin-expensive" | "internal" | "default";
export type IdentityRateLimitPolicyName = "auth-password" | "auth-session" | "auth-mutate"
  | "admin-read" | "admin-write" | "admin-expensive" | "internal";
export type ConcretePolicyName = Exclude<RateLimitPolicyName, "exempt"> | "auth-failure" | "login-global";

export interface RateLimitPolicies {
  policies: Record<ConcretePolicyName, TokenBucketPolicy>;
  sharedOrigin: boolean;
  trustedIps: ReadonlySet<string>;
}

declare module "fastify" { interface FastifyContextConfig { rateLimit?: RateLimitPolicyName } }

export function normalizeIp(value: string): string {
  const input = value.trim().toLowerCase();
  if (isIP(input) !== 6) return input;
  const halves = input.split("::");
  const expandEmbeddedIpv4 = (parts: string[]): string[] => {
    const last = parts.at(-1);
    if (!last || isIP(last) !== 4) return parts;
    const octets = last.split(".").map(Number);
    return [...parts.slice(0, -1), ((octets[0]! << 8) | octets[1]!).toString(16),
      ((octets[2]! << 8) | octets[3]!).toString(16)];
  };
  const left = expandEmbeddedIpv4((halves[0] ?? "").split(":").filter(Boolean));
  const right = expandEmbeddedIpv4((halves[1] ?? "").split(":").filter(Boolean));
  const expanded = halves.length === 2
    ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]
    : left;
  return `${expanded.slice(0, 4).map((part) => part.padStart(4, "0")).join(":")}::/64`;
}

export function isLoopbackHost(host: string | undefined): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function createRateLimitPolicies(config: AppConfig): RateLimitPolicies {
  const perMinute = (capacity: number): TokenBucketPolicy => ({ capacity, refillPeriodMs: 60_000 });
  return {
    sharedOrigin: !config.trustProxy && isLoopbackHost(config.host),
    trustedIps: new Set(config.rateLimitTrustedIps.map(normalizeIp)),
    policies: {
      login: perMinute(config.rateLimitLoginPerMinute),
      "login-global": perMinute(config.rateLimitLoginGlobalPerMinute),
      "auth-password": { capacity: 5, refillPeriodMs: 15 * 60_000 },
      "auth-session": perMinute(120),
      "auth-mutate": perMinute(config.rateLimitAdminWritePerMinute),
      "admin-read": perMinute(config.rateLimitAdminReadPerMinute),
      "admin-write": perMinute(config.rateLimitAdminWritePerMinute),
      "admin-expensive": perMinute(config.rateLimitAdminExpensivePerMinute),
      internal: perMinute(config.rateLimitInternalPerMinute),
      "auth-failure": perMinute(config.rateLimitAuthFailurePerMinute),
      default: perMinute(120),
    },
  };
}

export function defaultAdminPolicy(method: string | string[]): RateLimitPolicyName {
  const methods = Array.isArray(method) ? method : [method];
  return methods.every((value) => ["GET", "HEAD", "OPTIONS"].includes(value)) ? "admin-read" : "admin-write";
}

export function isIdentityPolicy(policy: RateLimitPolicyName): policy is IdentityRateLimitPolicyName {
  return ["auth-password", "auth-session", "auth-mutate", "admin-read", "admin-write", "admin-expensive", "internal"]
    .includes(policy);
}
