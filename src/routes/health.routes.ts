import type { FastifyInstance } from "fastify";
import { readinessFailure, type ReadinessService } from "../readiness/readiness.service.js";

export async function healthRoutes(app: FastifyInstance, options: {
  readiness?: Pick<ReadinessService, "check">;
} = {}): Promise<void> {
  app.get("/health", { config: { rateLimit: "exempt" } }, async () => ({ status: "ok" }));
  app.get("/ready", { config: { rateLimit: "exempt" } }, async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      const result = options.readiness ? await options.readiness.check() : readinessFailure();
      return reply.status(result.ready ? 200 : 503).send(result);
    } catch {
      return reply.status(503).send(readinessFailure());
    }
  });
}
