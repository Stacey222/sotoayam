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

async function expectUnauthorized(
  request: FastifyRequest,
  adminApiKey: string | undefined,
  message = DEFAULT_ADMIN_UNAUTHORIZED_MESSAGE,
): Promise<void> {
  let thrown: unknown;
  try {
    await resolveAdminPrincipal(request, { adminApiKey }, { unauthorizedMessage: message });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toMatchObject({ statusCode: 401, code: "UNAUTHORIZED", message });
}

describe("centralized admin authorization", () => {
  it("rejects when no admin API key is configured", async () => {
    await expectUnauthorized(requestWithAdminHeader(ADMIN_API_KEY), undefined);
  });

  it("rejects when the configured admin API key is empty", async () => {
    await expectUnauthorized(requestWithAdminHeader(ADMIN_API_KEY), "");
  });

  it("rejects when the request header is missing", async () => {
    await expectUnauthorized(requestWithAdminHeader(), ADMIN_API_KEY);
  });

  it("rejects when the request key is wrong", async () => {
    await expectUnauthorized(requestWithAdminHeader("wrong-admin-key"), ADMIN_API_KEY);
  });

  it("resolves the shared-key principal when the request key matches", async () => {
    expect(await resolveAdminPrincipal(requestWithAdminHeader(ADMIN_API_KEY), { adminApiKey: ADMIN_API_KEY }))
      .toEqual({ kind: "shared-api-key" });
  });

  it("rejects a duplicated header represented as an array with 401", async () => {
    await expectUnauthorized(requestWithAdminHeader([ADMIN_API_KEY, ADMIN_API_KEY]), ADMIN_API_KEY);
  });

  it("preserves a custom unauthorized message", async () => {
    await expectUnauthorized(requestWithAdminHeader("wrong-admin-key"), ADMIN_API_KEY, "Invalid or missing report API key");
  });

  it("marks wrapped route plugins and not bare route functions", () => {
    const bareRoutes = async (): Promise<void> => undefined;
    const protectedRoutes = defineAdminRoutes(bareRoutes);

    expect(isAdminRouteScope(protectedRoutes)).toBe(true);
    expect(isAdminRouteScope(bareRoutes)).toBe(false);
    expect(isAdminRouteScope(undefined)).toBe(false);
  });
});
