import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { TelegramUsersRepository } from "../repositories/telegram-users.repository.js";
import { secureEqual } from "../security.js";
import { parsePositiveId, parseUserFilters, parseUserUpdate } from "../validation.js";
import { AppError } from "../errors.js";
import type { UserManagementService } from "../services/user-management.service.js";
import type { UserUpdate } from "../types/index.js";

export interface UsersRoutesOptions {
  repository: TelegramUsersRepository;
  adminApiKey?: string;
  accessService?: UserManagementService;
}

export async function usersRoutes(app: FastifyInstance, options: UsersRoutesOptions): Promise<void> {
  const authorize = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    // TODO SECURITY: replace the shared key with authenticated admin identities and audit logs.
    if (!options.adminApiKey || !secureEqual(request.headers["x-admin-api-key"] as string | undefined, options.adminApiKey)) {
      throw new AppError(401, "UNAUTHORIZED", "Invalid or missing admin API key");
    }
  };

  app.addHook("preHandler", authorize);

  app.get("/", async (request) => ({ success: true, data: await options.repository.findAll(parseUserFilters(request.query)) }));

  app.get<{ Params: { id: string } }>("/:id", async (request) => {
    const user = await options.repository.findById(parsePositiveId(request.params.id));
    if (!user) throw new AppError(404, "NOT_FOUND", "Telegram user not found");
    return { success: true, data: user };
  });

  app.patch<{ Params: { id: string } }>("/:id", async (request) => {
    const id = parsePositiveId(request.params.id);
    const update = parseUserUpdate(request.body);
    const hasAccessUpdate = update.division !== undefined || update.role !== undefined || update.active !== undefined;
    if (hasAccessUpdate && options.accessService) await options.accessService.updateLegacyAccess(id, update);
    const legacyOnly = Object.fromEntries(Object.entries(update).filter(([field]) => !["division", "role", "active"].includes(field))) as UserUpdate;
    let user = Object.keys(legacyOnly).length > 0
      ? await options.repository.updateUser(id, legacyOnly)
      : await options.repository.findById(id);
    if (!options.accessService && hasAccessUpdate) user = await options.repository.updateUser(id, update);
    if (!user) throw new AppError(404, "NOT_FOUND", "Telegram user not found");
    request.log.info({ userId: id }, "Telegram user updated");
    return { success: true, data: user };
  });
}
