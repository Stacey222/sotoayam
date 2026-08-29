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
import { healthRoutes } from "./routes/health.routes.js";
import { notificationRoutes } from "./routes/notifications.routes.js";
import { usersRoutes } from "./routes/users.routes.js";
import { NotificationService } from "./services/notification.service.js";
import { RecipientResolverService } from "./services/recipient-resolver.service.js";
import { TelegramService, type TelegramSender } from "./services/telegram.service.js";
import {
  TelegramRegistrationService,
  type TelegramRegistrationWriter,
} from "./services/telegram-registration.service.js";
import { TelegramBot } from "./telegram/bot.js";

export interface BuildAppOptions {
  config: AppConfig;
  repository?: TelegramUsersRepository;
  registrationWriter?: TelegramRegistrationWriter;
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
  const resolver = new RecipientResolverService(repository);
  const notificationService = new NotificationService(resolver, telegramSender, app.log);
  const bot = new TelegramBot(options.config.telegramBotToken, registrationService, telegramSender, app.log);

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
  });
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
