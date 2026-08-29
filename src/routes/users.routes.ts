import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { TelegramUsersRepository } from "../repositories/telegram-users.repository.js";
import { secureEqual } from "../security.js";
import { parsePositiveId, parseUserFilters, parseUserUpdate } from "../validation.js";
import { AppError } from "../errors.js";

export interface UsersRoutesOptions {
  repository: TelegramUsersRepository;
  adminApiKey?: string;
}

export async function usersRoutes(app: FastifyInstance, options: UsersRoutesOptions): Promise<void> {
  const authorize = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    // TODO SECURITY: replace the shared key with authenticated admin identities and audit logs.
    if (options.adminApiKey && !secureEqual(request.headers["x-admin-api-key"] as string | undefined, options.adminApiKey)) {
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
    const user = await options.repository.updateUser(id, parseUserUpdate(request.body));
    if (!user) throw new AppError(404, "NOT_FOUND", "Telegram user not found");
    request.log.info({ userId: id }, "Telegram user updated");
    return { success: true, data: user };
  });
}
