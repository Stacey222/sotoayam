import type { FastifyInstance } from "fastify";
import type { NotificationSender } from "../services/notification.service.js";
import { parseNotificationEvent } from "../validation.js";
import { authorizeInternalIntegration, type InternalIntegrationAuthorizationOptions } from "../auth/internal-integration-authorization.js";

export interface NotificationRoutesOptions extends InternalIntegrationAuthorizationOptions {
  notificationService: NotificationSender;
}

export async function notificationRoutes(app: FastifyInstance, options: NotificationRoutesOptions): Promise<void> {
  app.post("/send", { config: { rateLimit: "internal" } }, async (request) => {
    const authorization = await authorizeInternalIntegration(request, options, null);
    if (authorization.kind === "integration-credential") {
      request.server.rateLimitIntegrationIdentity?.(request, authorization.principal.integrationId);
    }
    const event = parseNotificationEvent(request.body);
    return options.notificationService.send(event,
      authorization.kind === "integration-credential" ? authorization.principal.integrationId : null);
  });
}
