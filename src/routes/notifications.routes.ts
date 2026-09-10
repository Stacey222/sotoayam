import type { FastifyInstance } from "fastify";
import { AppError } from "../errors.js";
import { secureEqual } from "../security.js";
import type { NotificationSender } from "../services/notification.service.js";
import { parseNotificationEvent } from "../validation.js";

export interface NotificationRoutesOptions {
  notificationService: NotificationSender;
  internalApiKey: string;
}

export async function notificationRoutes(app: FastifyInstance, options: NotificationRoutesOptions): Promise<void> {
  app.post("/send", { config: { rateLimit: "internal" } }, async (request) => {
    const providedKey = request.headers["x-internal-api-key"] as string | undefined;
    if (!secureEqual(providedKey, options.internalApiKey)) {
      throw new AppError(401, "UNAUTHORIZED", "Invalid or missing internal API key");
    }
    const event = parseNotificationEvent(request.body);
    return options.notificationService.send(event);
  });
}
