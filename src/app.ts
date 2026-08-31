import path from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config/env.js";
import { createSupabaseClient } from "./db/supabase.js";
import { AppError } from "./errors.js";
import {
  SupabaseTelegramUsersRepository,
  type TelegramUsersRepository,
} from "./repositories/telegram-users.repository.js";
import { SupabaseNormalizedRegistrationRepository } from "./repositories/normalized-registration.repository.js";
import { SupabaseDivisionsRepository } from "./repositories/divisions.repository.js";
import { SupabaseRolesRepository } from "./repositories/roles.repository.js";
import { SupabaseSystemAuthorityRepository } from "./repositories/system-authority.repository.js";
import { SupabaseUserManagementRepository } from "./repositories/user-management.repository.js";
import { SupabaseUsersRepository } from "./repositories/users.repository.js";
import { SupabaseUserAccessStateRepository } from "./repositories/user-access-state.repository.js";
import { SupabaseUserChannelsRepository } from "./repositories/user-channels.repository.js";
import { SupabaseTasksRepository } from "./repositories/tasks.repository.js";
import { SupabaseTaskUsersRepository } from "./repositories/task-users.repository.js";
import { SupabaseTaskActivitiesRepository } from "./repositories/task-activities.repository.js";
import { SupabaseTaskRelationshipsRepository } from "./repositories/task-relationships.repository.js";
import { SupabasePermissionsRepository } from "./repositories/permissions.repository.js";
import { SupabaseAuditRepository } from "./repositories/audit.repository.js";
import { SupabaseDivisionCollaborationRepository } from "./repositories/division-collaboration.repository.js";
import { adminUserManagementRoutes } from "./routes/admin-user-management.routes.js";
import { healthRoutes } from "./routes/health.routes.js";
import { notificationRoutes } from "./routes/notifications.routes.js";
import { usersRoutes } from "./routes/users.routes.js";
import { systemAuthorityRoutes } from "./routes/system-authority.routes.js";
import { tasksRoutes } from "./routes/tasks.routes.js";
import { collaborationRulesRoutes } from "./routes/collaboration-rules.routes.js";
import { NotificationService } from "./services/notification.service.js";
import { RecipientResolverService } from "./services/recipient-resolver.service.js";
import { TelegramService, type TelegramSender } from "./services/telegram.service.js";
import { UserManagementService } from "./services/user-management.service.js";
import { SystemAuthorityService } from "./services/system-authority.service.js";
import { UserAccessStateService, type UserAccessStateResolver } from "./services/user-access-state.service.js";
import { resolveUserAccessState } from "./identity/user-access-state.js";
import { TelegramTaskActorService, TrustedTaskActorService } from "./services/task-actor.service.js";
import { TaskAuthorizationService } from "./services/task-authorization.service.js";
import { TaskService } from "./services/task.service.js";
import { DivisionCollaborationService } from "./services/division-collaboration.service.js";
import { CollaborationRuleManagementService } from "./services/collaboration-rule-management.service.js";
import {
  TelegramRegistrationService,
  type TelegramRegistrationWriter,
} from "./services/telegram-registration.service.js";
import { TelegramBot } from "./telegram/bot.js";
import { TelegramItConsoleService } from "./telegram/it-console.js";
import { TelegramTaskConsoleService } from "./telegram/task-console.js";

export interface BuildAppOptions {
  config: AppConfig;
  repository?: TelegramUsersRepository;
  registrationWriter?: TelegramRegistrationWriter;
  accessStateResolver?: UserAccessStateResolver;
  telegramSender?: TelegramSender;
  logger?: boolean;
}

export interface AppRuntime {
  app: FastifyInstance;
  bot: TelegramBot;
}

export async function buildApp(options: BuildAppOptions): Promise<AppRuntime> {
  const app = Fastify({ logger: options.logger === false ? false : { level: options.config.logLevel } });
  const client = options.repository ? null : createSupabaseClient(options.config);
  const repository = options.repository ?? new SupabaseTelegramUsersRepository(client!);
  const registrationWriter = options.registrationWriter
    ?? (options.repository ? options.repository : new SupabaseNormalizedRegistrationRepository(client!));
  const registrationService = new TelegramRegistrationService(registrationWriter);
  const telegramSender = options.telegramSender ?? new TelegramService(options.config.telegramBotToken, app.log);
  const accessStateResolver = options.accessStateResolver
    ?? (client
      ? new UserAccessStateService(new SupabaseUserAccessStateRepository(client))
      : {
          resolveByLegacyTelegramUserId: async (legacyUserId: number) => {
            const legacyUser = await repository.findById(legacyUserId);
            if (!legacyUser) throw new AppError(404, "NORMALIZED_USER_NOT_FOUND", "Injected user access state not found");
            return resolveUserAccessState({
              active: legacyUser.active,
              divisionId: legacyUser.division === "UNASSIGNED" ? null : 1,
              roleId: legacyUser.role === "UNASSIGNED" ? null : 1,
              divisionCode: legacyUser.division === "UNASSIGNED" ? null : legacyUser.division,
              roleCode: legacyUser.role === "UNASSIGNED" ? null : legacyUser.role.toUpperCase(),
            });
          },
        });
  const resolver = new RecipientResolverService(repository);
  const notificationService = new NotificationService(resolver, telegramSender, app.log);
  const userManagementService = client ? new UserManagementService(
    new SupabaseUserManagementRepository(client),
    new SupabaseDivisionsRepository(client),
    new SupabaseRolesRepository(client),
  ) : undefined;
  const systemAuthorityService = client ? new SystemAuthorityService(
    new SupabaseUsersRepository(client), new SupabaseSystemAuthorityRepository(client),
  ) : undefined;
  const taskUsers = client ? new SupabaseTaskUsersRepository(client) : undefined;
  const collaborationRepository = client ? new SupabaseDivisionCollaborationRepository(client) : undefined;
  const permissionsRepository = client ? new SupabasePermissionsRepository(client) : undefined;
  const divisionsRepository = client ? new SupabaseDivisionsRepository(client) : undefined;
  const taskService = client && taskUsers && collaborationRepository ? new TaskService(
    new SupabaseTasksRepository(client), taskUsers, new SupabaseTaskActivitiesRepository(client),
    new SupabaseTaskRelationshipsRepository(client), new SupabaseAuditRepository(client), new TaskAuthorizationService(),
    undefined, new DivisionCollaborationService(collaborationRepository),
  ) : undefined;
  const collaborationManagementService = client && userManagementService && taskUsers && collaborationRepository
    ? new CollaborationRuleManagementService(
        collaborationRepository,
        new SupabaseDivisionsRepository(client),
        taskUsers,
        userManagementService,
        new SupabaseSystemAuthorityRepository(client),
        new SupabaseAuditRepository(client),
      )
    : undefined;
  const itConsole = client && userManagementService ? new TelegramItConsoleService(
    new SupabaseUserChannelsRepository(client),
    new SupabaseSystemAuthorityRepository(client),
    userManagementService,
    collaborationManagementService,
  ) : undefined;
  const taskConsole = client && taskService && taskUsers && permissionsRepository && divisionsRepository && collaborationRepository
    ? new TelegramTaskConsoleService(
        taskService,
        new TelegramTaskActorService(new SupabaseUserChannelsRepository(client), taskUsers, permissionsRepository),
        taskUsers,
        divisionsRepository,
        collaborationRepository,
      )
    : undefined;
  const bot = new TelegramBot(
    options.config.telegramBotToken,
    registrationService,
    accessStateResolver,
    telegramSender,
    app.log,
    itConsole,
    taskConsole,
  );

  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof AppError ? error : null;
    const rawStatus = typeof error === "object" && error !== null && "statusCode" in error
      ? (error as { statusCode?: unknown }).statusCode
      : undefined;
    const frameworkStatus = typeof rawStatus === "number" && rawStatus >= 400 && rawStatus < 500
      ? rawStatus
      : null;
    const statusCode = appError?.statusCode ?? frameworkStatus ?? 500;
    const errorCode = appError?.code ?? (frameworkStatus ? "INVALID_REQUEST" : "INTERNAL_ERROR");
    const errorMessage = appError?.message ?? (frameworkStatus ? "Invalid request" : "An unexpected error occurred");
    if (statusCode >= 500) request.log.error({ err: error }, "Request failed");
    else request.log.warn({ code: errorCode, path: request.url }, "Request rejected");
    return reply.status(statusCode).send({
      success: false,
      error: {
        code: errorCode,
        message: errorMessage,
      },
    });
  });

  app.setNotFoundHandler((_request, reply) => reply.status(404).send({
    success: false,
    error: { code: "NOT_FOUND", message: "Route not found" },
  }));

  await app.register(healthRoutes);
  await app.register(usersRoutes, {
    prefix: "/api/users",
    repository,
    adminApiKey: options.config.adminApiKey,
    accessService: userManagementService,
  });
  if (userManagementService) await app.register(adminUserManagementRoutes, {
    prefix: "/api/admin/users",
    service: userManagementService,
    adminApiKey: options.config.adminApiKey,
  });
  if (systemAuthorityService) await app.register(systemAuthorityRoutes, {
    prefix: "/api/admin/system-authority",
    service: systemAuthorityService,
    adminApiKey: options.config.adminApiKey,
  });
  if (collaborationManagementService) await app.register(collaborationRulesRoutes, {
    prefix: "/api/admin/collaboration-rules",
    service: collaborationManagementService,
    adminApiKey: options.config.adminApiKey,
  });
  if (taskService && taskUsers && permissionsRepository) {
    await app.register(tasksRoutes, {
      prefix: "/api/tasks",
      service: taskService,
      actorResolver: new TrustedTaskActorService(taskUsers, permissionsRepository),
      adminApiKey: options.config.adminApiKey,
    });
  }
  await app.register(notificationRoutes, {
    prefix: "/api/notifications",
    notificationService,
    internalApiKey: options.config.internalApiKey,
  });

  await app.register(fastifyStatic, {
    root: path.resolve(process.cwd(), "public"),
    prefix: "/",
    wildcard: false,
  });

  return { app, bot };
}
