import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi, type Mock } from "vitest";
import { adminNotificationsRoutes } from "../../src/routes/admin-notifications.routes.js";
import { adminUserManagementRoutes } from "../../src/routes/admin-user-management.routes.js";
import { collaborationRulesRoutes } from "../../src/routes/collaboration-rules.routes.js";
import { adminCriticalAlertRoutes, criticalAlertsRoutes } from "../../src/routes/critical-alerts.routes.js";
import { integrationAdministrationRoutes } from "../../src/routes/integration-administration.routes.js";
import { reportsRoutes } from "../../src/routes/reports.routes.js";
import { systemAuthorityRoutes } from "../../src/routes/system-authority.routes.js";
import { csvImportRoutes } from "../../src/routes/task-ingestion.routes.js";
import { tasksRoutes } from "../../src/routes/tasks.routes.js";
import { usersRoutes } from "../../src/routes/users.routes.js";
import { taxonomyRoutes } from "../../src/routes/taxonomy.routes.js";

const ADMIN_API_KEY = "regression-admin-key";

interface RouteCase {
  routeGroup: string;
  endpoint: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  payload?: string;
  unauthorizedMessage?: string;
  assertSecondaryGuardOrdering?: boolean;
  register: (
    app: FastifyInstance,
    adminApiKey: string | undefined,
    downstream: Mock,
    secondaryAuthorization: Mock,
  ) => Promise<void>;
}

const trustedActor = {
  id: 1,
  displayName: "Admin",
  active: true,
  divisionId: 1,
  divisionCode: "IT",
  divisionGrantsSystemAuthority: true,
  roleId: 1,
  roleCode: "ADMIN",
  permissions: new Set<string>(),
};

const routeCases: RouteCase[] = [
  {
    routeGroup: "taxonomy",
    endpoint: "/divisions",
    register: async (app, adminApiKey, downstream, secondaryAuthorization) => {
      await app.register(taxonomyRoutes, {
        service: { listDivisions: downstream } as never,
        categories: {} as never,
        actorResolver: { resolveTrustedActor: secondaryAuthorization },
        ...(adminApiKey === undefined ? {} : { adminApiKey }),
      });
    },
  },
  {
    routeGroup: "users",
    endpoint: "/",
    register: async (app, adminApiKey, downstream) => {
      await app.register(usersRoutes, {
        repository: { findAll: downstream } as never,
        ...(adminApiKey === undefined ? {} : { adminApiKey }),
      });
    },
  },
  {
    routeGroup: "admin-user-management",
    endpoint: "/",
    register: async (app, adminApiKey, downstream) => {
      await app.register(adminUserManagementRoutes, {
        service: { list: downstream } as never,
        ...(adminApiKey === undefined ? {} : { adminApiKey }),
      });
    },
  },
  {
    routeGroup: "system-authority",
    endpoint: "/status",
    register: async (app, adminApiKey, downstream) => {
      await app.register(systemAuthorityRoutes, {
        service: { status: downstream } as never,
        ...(adminApiKey === undefined ? {} : { adminApiKey }),
      });
    },
  },
  {
    routeGroup: "collaboration-rules",
    endpoint: "/",
    register: async (app, adminApiKey, downstream) => {
      await app.register(collaborationRulesRoutes, {
        service: { list: downstream } as never,
        ...(adminApiKey === undefined ? {} : { adminApiKey }),
      });
    },
  },
  {
    routeGroup: "integration-administration",
    endpoint: "/",
    register: async (app, adminApiKey, downstream) => {
      await app.register(integrationAdministrationRoutes, {
        service: { list: downstream } as never,
        ...(adminApiKey === undefined ? {} : { adminApiKey }),
      });
    },
  },
  {
    routeGroup: "tasks",
    endpoint: "/",
    register: async (app, adminApiKey, downstream, secondaryAuthorization) => {
      await app.register(tasksRoutes, {
        service: { list: downstream } as never,
        actorResolver: { resolveTrustedActor: secondaryAuthorization },
        ...(adminApiKey === undefined ? {} : { adminApiKey }),
      });
    },
  },
  {
    routeGroup: "csv-import",
    endpoint: "/csv",
    method: "POST",
    headers: { "content-type": "text/csv" },
    payload: "title,owner_division\nTask,IT",
    register: async (app, adminApiKey, downstream, secondaryAuthorization) => {
      await app.register(csvImportRoutes, {
        service: { importCsv: downstream } as never,
        actorResolver: { resolveTrustedActor: secondaryAuthorization },
        ...(adminApiKey === undefined ? {} : { adminApiKey }),
      });
    },
  },
  {
    routeGroup: "admin-notifications",
    endpoint: "/status",
    assertSecondaryGuardOrdering: true,
    register: async (app, adminApiKey, downstream, secondaryAuthorization) => {
      await app.register(adminNotificationsRoutes, {
        service: { status: downstream } as never,
        actorResolver: { resolveTrustedActor: secondaryAuthorization },
        ...(adminApiKey === undefined ? {} : { adminApiKey }),
      });
    },
  },
  {
    routeGroup: "reports",
    endpoint: "/content-creator/affiliate-task-status",
    unauthorizedMessage: "Invalid or missing report API key",
    register: async (app, adminApiKey, downstream, secondaryAuthorization) => {
      await app.register(reportsRoutes, {
        service: { affiliateTaskStatus: downstream } as never,
        actorResolver: { resolveOwnerActor: secondaryAuthorization },
        ...(adminApiKey === undefined ? {} : { adminApiKey }),
      });
    },
  },
  {
    routeGroup: "critical-alerts",
    endpoint: "/",
    unauthorizedMessage: "Invalid or missing alert API key",
    register: async (app, adminApiKey, downstream, secondaryAuthorization) => {
      await app.register(criticalAlertsRoutes, {
        service: { list: downstream } as never,
        actorResolver: { resolveOwnerActor: secondaryAuthorization },
        ...(adminApiKey === undefined ? {} : { adminApiKey }),
      });
    },
  },
  {
    routeGroup: "admin-critical-alerts",
    endpoint: "/evaluate?dry_run=true",
    method: "POST",
    assertSecondaryGuardOrdering: true,
    register: async (app, adminApiKey, downstream, secondaryAuthorization) => {
      downstream.mockResolvedValue({ candidates: 0, observations: [] });
      await app.register(adminCriticalAlertRoutes, {
        evaluator: { evaluate: downstream } as never,
        actorResolver: { resolveTrustedActor: secondaryAuthorization },
        ...(adminApiKey === undefined ? {} : { adminApiKey }),
      });
    },
  },
];

const authCases = [
  { condition: "rejects when no admin API key is configured", adminApiKey: undefined, requestKey: ADMIN_API_KEY, expectedStatus: 401 },
  { condition: "rejects when the request key is missing", adminApiKey: ADMIN_API_KEY, requestKey: undefined, expectedStatus: 401 },
  { condition: "rejects when the request key is wrong", adminApiKey: ADMIN_API_KEY, requestKey: "wrong-admin-key", expectedStatus: 401 },
  { condition: "continues to the route when the request key matches", adminApiKey: ADMIN_API_KEY, requestKey: ADMIN_API_KEY, expectedStatus: 200 },
];

describe.each(routeCases)("$routeGroup admin authorization", ({
  endpoint,
  method = "GET",
  headers = {},
  payload,
  unauthorizedMessage = "Invalid or missing admin API key",
  assertSecondaryGuardOrdering = false,
  register,
}) => {
  it.each(authCases)("$condition", async ({ adminApiKey, requestKey, expectedStatus }) => {
    const app = Fastify({ logger: false });
    const downstream = vi.fn().mockResolvedValue([]);
    const secondaryAuthorization = vi.fn().mockResolvedValue(trustedActor);

    try {
      await register(app, adminApiKey, downstream, secondaryAuthorization);
      const response = await app.inject({
        method,
        url: endpoint,
        headers: {
          ...headers,
          ...(requestKey === undefined ? {} : { "x-admin-api-key": requestKey }),
        },
        ...(payload === undefined ? {} : { payload }),
      });

      expect(response.statusCode).toBe(expectedStatus);
      if (expectedStatus === 401) {
        expect(response.json()).toMatchObject({ code: "UNAUTHORIZED", message: unauthorizedMessage });
        expect(downstream).not.toHaveBeenCalled();
        if (assertSecondaryGuardOrdering) expect(secondaryAuthorization).not.toHaveBeenCalled();
      } else {
        expect(downstream).toHaveBeenCalledOnce();
        if (assertSecondaryGuardOrdering) expect(secondaryAuthorization).toHaveBeenCalledOnce();
      }
    } finally {
      await app.close();
    }
  });
});
