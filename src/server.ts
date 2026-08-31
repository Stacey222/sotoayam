import { buildApp } from "./app.js";
import { loadConfig } from "./config/env.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const { app, bot } = await buildApp({ config });
  const host = config.host ?? "0.0.0.0";

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "Shutting down");
    bot.stop();
    await app.close();
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host, port: config.port });
  app.log.info(
    {
      host,
      port: config.port,
      telegramPolling: config.telegramPollingEnabled,
      adminProtected: Boolean(config.adminApiKey),
    },
    "Gwens Automation Control started",
  );
  if (config.telegramPollingEnabled) {
    void bot.start().catch((error: unknown) => {
      app.log.error(
        { errorType: error instanceof Error ? error.name : "UnknownError" },
        "Telegram bot stopped unexpectedly",
      );
    });
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown startup error";
  process.stderr.write(`Startup failed: ${message}\n`);
  process.exitCode = 1;
});
