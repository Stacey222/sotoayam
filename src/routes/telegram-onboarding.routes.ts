import { defineAdminRoutes, requireSessionPrincipal, type AdminAuthorizedRouteOptions } from "../auth/admin-authorization.js";
import type { TelegramOnboardingService } from "../services/telegram-onboarding.service.js";

export interface TelegramOnboardingRoutesOptions extends AdminAuthorizedRouteOptions { service: TelegramOnboardingService }

export const telegramOnboardingRoutes = defineAdminRoutes<TelegramOnboardingRoutesOptions>(async (app, options) => {
  app.addHook("preHandler", async (request) => { requireSessionPrincipal(request); });
  app.get("/", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { success: true, data: await options.service.state(requireSessionPrincipal(request).adminUserId) };
  });
  app.post("/pairings", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { success: true, data: await options.service.createPairing(requireSessionPrincipal(request).adminUserId) };
  });
  app.put("/preferences", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { success: true, data: await options.service.updatePreferences(
      requireSessionPrincipal(request).adminUserId, request.body) };
  });
});
