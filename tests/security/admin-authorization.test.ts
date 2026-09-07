import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import {
  ADMIN_API_KEY_HEADER,
  DEFAULT_ADMIN_UNAUTHORIZED_MESSAGE,
  defineAdminRoutes,
  isAdminRouteScope,
  resolveAdminPrincipal,
} from "../../src/auth/admin-authorization.js";

const ADMIN_API_KEY = "primitive-admin-key";

function requestWithAdminHeader(value?: string | string[]): FastifyRequest {
  return {
    headers: value === undefined ? {} : { [ADMIN_API_KEY_HEADER]: value },
  } as unknown as FastifyRequest;
}

function expectUnauthorized(
  request: FastifyRequest,
  adminApiKey: string | undefined,
  message = DEFAULT_ADMIN_UNAUTHORIZED_MESSAGE,
): void {
  let thrown: unknown;
  try {
    resolveAdminPrincipal(request, { adminApiKey }, { unauthorizedMessage: message });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toMatchObject({ statusCode: 401, code: "UNAUTHORIZED", message });
}

describe("centralized admin authorization", () => {
  it("rejects when no admin API key is configured", () => {
    expectUnauthorized(requestWithAdminHeader(ADMIN_API_KEY), undefined);
  });

  it("rejects when the configured admin API key is empty", () => {
    expectUnauthorized(requestWithAdminHeader(ADMIN_API_KEY), "");
  });

  it("rejects when the request header is missing", () => {
    expectUnauthorized(requestWithAdminHeader(), ADMIN_API_KEY);
  });

  it("rejects when the request key is wrong", () => {
    expectUnauthorized(requestWithAdminHeader("wrong-admin-key"), ADMIN_API_KEY);
  });

  it("resolves the shared-key principal when the request key matches", () => {
    expect(resolveAdminPrincipal(requestWithAdminHeader(ADMIN_API_KEY), { adminApiKey: ADMIN_API_KEY }))
      .toEqual({ kind: "shared-api-key" });
  });

  it("rejects a duplicated header represented as an array with 401", () => {
    expectUnauthorized(requestWithAdminHeader([ADMIN_API_KEY, ADMIN_API_KEY]), ADMIN_API_KEY);
  });

  it("preserves a custom unauthorized message", () => {
    expectUnauthorized(requestWithAdminHeader("wrong-admin-key"), ADMIN_API_KEY, "Invalid or missing report API key");
  });

  it("marks wrapped route plugins and not bare route functions", () => {
    const bareRoutes = async (): Promise<void> => undefined;
    const protectedRoutes = defineAdminRoutes(bareRoutes);

    expect(isAdminRouteScope(protectedRoutes)).toBe(true);
    expect(isAdminRouteScope(bareRoutes)).toBe(false);
    expect(isAdminRouteScope(undefined)).toBe(false);
  });
});
