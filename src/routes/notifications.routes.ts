import type { FastifyInstance } from "fastify";
import { AppError } from "../errors.js";
import { secureEqual } from "../security.js";
import type { NotificationService } from "../services/notification.service.js";
import { parseNotificationEvent } from "../validation.js";

export interface NotificationRoutesOptions {
  notificationService: NotificationService;
  internalApiKey: string;
}

export async function notificationRoutes(app: FastifyInstance, options: NotificationRoutesOptions): Promise<void> {
  app.post("/send", async (request) => {
    const providedKey = request.headers["x-internal-api-key"] as string | undefined;
    if (!secureEqual(providedKey, options.internalApiKey)) {
      throw new AppError(401, "UNAUTHORIZED", "Invalid or missing internal API key");
    }
    const event = parseNotificationEvent(request.body);
    request.log.info({ type: event.type, eventId: event.event_id }, "Notification event received");
    return options.notificationService.send(event);
  });
}
