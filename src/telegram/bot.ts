import type { FastifyBaseLogger } from "fastify";
import { DatabaseError } from "../errors.js";
import type { TelegramRegistrationService } from "../services/telegram-registration.service.js";
import { TelegramApiClient, TelegramApiError, type TelegramSender } from "../services/telegram.service.js";
import type { UserAccessStateResolver } from "../services/user-access-state.service.js";
import type { TelegramUser } from "../types/index.js";
import type { TelegramItConsole } from "./it-console.js";
import type { TelegramTaskConsole } from "./task-console.js";
import type { TelegramOwnerConsole } from "./owner-console.js";
import type { RuntimeHealthState } from "../runtime/health-state.js";

interface TelegramUpdate {
  update_id: number;
  message?: {
    text?: string;
    chat: { id: number; type?: string; username?: string; first_name?: string };
    from?: { id?: number; username?: string; first_name?: string };
  };
  callback_query?: {
    id: string;
    from: { id: number };
    data?: string;
    message?: { message_id: number; chat: { id: number; type?: string } };
  };
}

export class TelegramBot {
  private offset = 0;
  private stopped = false;
  private controller?: AbortController;

  constructor(
    private readonly token: string,
    private readonly registrationService: TelegramRegistrationService,
    private readonly accessStateResolver: UserAccessStateResolver,
    private readonly sender: TelegramSender,
    private readonly logger: Pick<FastifyBaseLogger, "info" | "warn" | "error">,
    private readonly itConsole?: TelegramItConsole,
    private readonly taskConsole?: TelegramTaskConsole,
    private readonly ownerConsole?: TelegramOwnerConsole,
    private readonly runtimeHealth?: RuntimeHealthState,
    private readonly telegramApi = new TelegramApiClient(),
  ) {}

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallback(update);
      return;
    }
    const message = update.message;
    if (!message) return;
    if (/^\/tasks(?:@\w+)?(?:\s|$)/i.test(message.text ?? "")) {
      this.logger.info({ updateId: update.update_id }, "Telegram /tasks received");
      if (message.from?.id === undefined || !this.isPrivateChat(message.chat, message.from.id)) {
        await this.sender.sendMessage(message.chat.id, "Task Console hanya tersedia melalui private chat.");
        return;
      }
      await this.sendConsoleResponse(message.chat.id, await this.openTaskConsole(message.from?.id));
      return;
    }
    if (/^\/admin(?:@\w+)?(?:\s|$)/i.test(message.text ?? "")) {
      this.logger.info({ updateId: update.update_id }, "Telegram /admin received");
      if (message.from?.id === undefined || !this.isPrivateChat(message.chat, message.from.id)) {
        await this.sender.sendMessage(message.chat.id, "IT Console hanya tersedia melalui private chat.");
        return;
      }
      await this.sendConsoleResponse(message.chat.id, await this.openConsole(message.from?.id));
      return;
    }
    if (/^\/owner(?:@\w+)?(?:\s|$)/i.test(message.text ?? "")) {
      this.logger.info({ updateId: update.update_id }, "Telegram /owner received");
      if (message.from?.id === undefined || !this.isPrivateChat(message.chat, message.from.id)) {
        await this.sender.sendMessage(message.chat.id, "Owner Console hanya tersedia melalui private chat.");
        return;
      }
      await this.sendConsoleResponse(message.chat.id, await this.openOwnerConsole(message.from.id));
      return;
    }
    if (!/^\/start(?:@\w+)?(?:\s|$)/i.test(message.text ?? "")) {
      if (this.itConsole && message.from?.id !== undefined && message.text !== undefined) {
        if (!this.isPrivateChat(message.chat, message.from.id)) return;
        try {
          const response = await this.itConsole.handleText(message.from.id, message.text);
          if (response) { await this.sendConsoleResponse(message.chat.id, response); return; }
        } catch (error) {
          this.logger.error({ errorType: error instanceof Error ? error.name : "UnknownError", updateId: update.update_id }, "Telegram IT console text failed");
          await this.sender.sendMessage(message.chat.id, "Permintaan belum dapat diproses. Silakan coba lagi.");
          return;
        }
      }
      if (this.taskConsole && message.from?.id !== undefined && message.text !== undefined) {
        if (!this.isPrivateChat(message.chat, message.from.id)) return;
        try {
          const response = await this.taskConsole.handleText(message.from.id, message.text);
          if (response) await this.sendConsoleResponse(message.chat.id, response);
        } catch (error) {
          this.logger.error(
            { errorType: error instanceof Error ? error.name : "UnknownError", updateId: update.update_id },
            "Telegram task input failed",
          );
          await this.sender.sendMessage(message.chat.id, "Permintaan belum dapat diproses. Silakan coba lagi.");
        }
      }
      return;
    }
    this.logger.info({ updateId: update.update_id }, "Telegram /start received");
    const username = message.from?.username ?? message.chat.username ?? null;
    const firstName = message.from?.first_name ?? message.chat.first_name ?? null;
    let registeredUser: TelegramUser;
    try {
      registeredUser = await this.registrationService.register({
        telegram_chat_id: message.chat.id,
        telegram_username: username,
        telegram_first_name: firstName,
      });
    } catch (error) {
      const diagnostic = error instanceof DatabaseError
        ? {
            errorCode: this.safeDiagnostic(error.diagnostic.code),
            errorMessage: this.safeDiagnostic(error.diagnostic.message),
            errorDetails: this.safeDiagnostic(error.diagnostic.details),
            errorHint: this.safeDiagnostic(error.diagnostic.hint),
          }
        : {};
      this.logger.error(
        {
          errorType: error instanceof Error ? error.name : "UnknownError",
          ...diagnostic,
          updateId: update.update_id,
        },
        "Telegram registration failed",
      );
      try {
        await this.sender.sendMessage(
          message.chat.id,
          "Registrasi Telegram Sotoayam belum dapat diproses. Silakan coba lagi beberapa saat atau hubungi Admin Sotoayam.",
        );
      } catch (sendError) {
        this.logger.error(
          {
            errorType: sendError instanceof Error ? sendError.name : "UnknownError",
            updateId: update.update_id,
          },
          "Telegram registration failure message could not be sent",
        );
      }
      return;
    }
    this.logger.info({ updateId: update.update_id }, "Telegram registration succeeded");
    try {
      const accessState = await this.accessStateResolver.resolveByLegacyTelegramUserId(registeredUser.id);
      this.logger.info(
        { updateId: update.update_id, accessStatus: accessState.status, division: accessState.divisionCode, role: accessState.roleCode },
        "Telegram final normalized access state resolved",
      );
      const response = accessState.status === "ACTIVE"
        ? `Akun Sotoayam aktif.\n\nDivisi: ${accessState.divisionCode}\nRole: ${accessState.roleCode}\nStatus: Aktif`
        : "Registrasi Telegram Sotoayam berhasil.\n\nStatus: Menunggu aktivasi Admin.\n\nSilakan hubungi Admin Sotoayam untuk menentukan Divisi dan Role Anda.";
      await this.sender.sendMessage(message.chat.id, response);
    } catch (error) {
      this.logger.error(
        { errorType: error instanceof Error ? error.name : "UnknownError", updateId: update.update_id },
        "Telegram final access state resolution or response failed",
      );
      try {
        await this.sender.sendMessage(
          message.chat.id,
          "Status akun Sotoayam belum dapat dimuat. Silakan coba lagi beberapa saat atau hubungi Admin Sotoayam.",
        );
      } catch (sendError) {
        this.logger.error(
          { errorType: sendError instanceof Error ? sendError.name : "UnknownError", updateId: update.update_id },
          "Telegram access state failure message could not be sent",
        );
      }
    }
  }

  private async handleCallback(update: TelegramUpdate): Promise<void> {
    const query = update.callback_query!;
    this.logger.info({ updateId: update.update_id }, "Telegram callback received");
    try {
      await this.sender.answerCallbackQuery?.(query.id);
    } catch (error) {
      this.logger.warn(
        { errorType: error instanceof Error ? error.name : "UnknownError", updateId: update.update_id },
        "Telegram callback acknowledgement failed",
      );
    }
    try {
      const message = query.message;
      if (!message) return;
      const data = query.data ?? "";
      const response = data.startsWith("tc:")
        ? this.isPrivateChat(message.chat, query.from.id) && this.taskConsole
          ? await this.taskConsole.handleCallback(query.from.id, data)
          : { text: "Perintah tidak tersedia." }
        : data.startsWith("oc:")
          ? this.isPrivateChat(message.chat, query.from.id) && this.ownerConsole
            ? await this.ownerConsole.handleCallback(query.from.id, data)
            : { text: "Perintah tidak tersedia." }
          : this.isPrivateChat(message.chat, query.from.id) && this.itConsole
            ? await this.itConsole.handleCallback(query.from.id, data)
            : { text: "Perintah tidak tersedia." };
      await this.editConsoleResponse(message.chat.id, message.message_id, response);
    } catch (error) {
      this.logger.error(
        { errorType: error instanceof Error ? error.name : "UnknownError", updateId: update.update_id },
        "Telegram console callback failed",
      );
      const chatId = query.message?.chat.id;
      if (chatId !== undefined) await this.sender.sendMessage(chatId, "Permintaan belum dapat diproses. Silakan coba lagi.");
    }
  }

  private async openConsole(externalTelegramId: number | undefined) {
    if (!this.itConsole || externalTelegramId === undefined) return { text: "Perintah tidak tersedia." };
    try {
      return await this.itConsole.open(externalTelegramId);
    } catch (error) {
      this.logger.error({ errorType: error instanceof Error ? error.name : "UnknownError" }, "Telegram console authorization failed");
      return { text: "Permintaan belum dapat diproses. Silakan coba lagi." };
    }
  }

  private async openTaskConsole(externalTelegramId: number | undefined) {
    if (!this.taskConsole || externalTelegramId === undefined) return { text: "Perintah tidak tersedia." };
    try {
      return await this.taskConsole.open(externalTelegramId);
    } catch (error) {
      this.logger.error({ errorType: error instanceof Error ? error.name : "UnknownError" }, "Telegram task console authorization failed");
      return { text: "Permintaan belum dapat diproses. Silakan coba lagi." };
    }
  }

  private async openOwnerConsole(externalTelegramId: number | undefined) {
    if (!this.ownerConsole || externalTelegramId === undefined) return { text: "Perintah tidak tersedia." };
    try {
      return await this.ownerConsole.open(externalTelegramId);
    } catch (error) {
      this.logger.error({ errorType: error instanceof Error ? error.name : "UnknownError" }, "Telegram Owner console authorization failed");
      return { text: "Permintaan belum dapat diproses. Silakan coba lagi." };
    }
  }

  private isPrivateChat(chat: { id: number; type?: string }, externalTelegramId: number): boolean {
    return chat.type === "private" || (chat.type === undefined && chat.id === externalTelegramId);
  }

  private sendConsoleResponse(chatId: number, response: { text: string; inlineKeyboard?: import("../services/telegram.service.js").TelegramInlineButton[][] }): Promise<void> {
    return this.sender.sendMessage(chatId, response.text, response.inlineKeyboard ? { inlineKeyboard: response.inlineKeyboard } : undefined);
  }

  private async editConsoleResponse(
    chatId: number,
    messageId: number,
    response: { text: string; inlineKeyboard?: import("../services/telegram.service.js").TelegramInlineButton[][] },
  ): Promise<void> {
    if (!this.sender.editMessage) {
      await this.sendConsoleResponse(chatId, response);
      return;
    }
    try {
      await this.sender.editMessage(chatId, messageId, response.text, response.inlineKeyboard ? { inlineKeyboard: response.inlineKeyboard } : undefined);
    } catch (error) {
      this.logger.warn(
        { errorType: error instanceof Error ? error.name : "UnknownError" },
        "Telegram menu edit failed; using safe replacement",
      );
      try {
        await this.sender.removeInlineKeyboard?.(chatId, messageId);
      } catch (markupError) {
        this.logger.warn(
          { errorType: markupError instanceof Error ? markupError.name : "UnknownError" },
          "Telegram stale keyboard removal failed",
        );
      }
      await this.sendConsoleResponse(chatId, response);
    }
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.controller = new AbortController();
    try {
      this.logger.info("Telegram bot initialization started");
      await this.telegramApi.call<{ username?: string }>(this.token, "getMe", {
        signal: this.controller.signal,
      });
      this.logger.info("Telegram getMe succeeded");
      if (this.runtimeHealth) this.runtimeHealth.telegramPollingActive = true;
      this.logger.info("Telegram polling started");
      while (!this.stopped) {
        const updates = await this.telegramApi.call<TelegramUpdate[]>(this.token, "getUpdates", {
          query: {
            offset: String(this.offset),
            timeout: "25",
            allowed_updates: JSON.stringify(["message", "callback_query"]),
          },
          signal: this.controller.signal,
          timeoutMs: 30_000,
        });
        for (const update of updates) {
          this.offset = update.update_id + 1;
          this.logger.info(
            { updateId: update.update_id, updateType: update.callback_query ? "callback_query" : "message" },
            "Telegram update received",
          );
          try {
            await this.handleUpdate(update);
          } catch (error) {
            this.logger.error(
              { errorType: error instanceof Error ? error.name : "UnknownError", updateId: update.update_id },
              "Telegram update failed",
            );
          }
        }
      }
    } catch (error) {
      if (this.stopped) return;
      if (error instanceof TelegramApiError) {
        this.logger.warn({
          transportKind: error.transportKind,
          attempts: error.attempts,
          retryExhausted: error.retryExhausted,
          httpStatus: error.httpStatus,
          telegramErrorCode: error.telegramErrorCode,
          telegramDescription: this.redact(error.telegramDescription),
        }, "Telegram polling stopped after bounded request retries");
      } else {
        this.logger.warn({ errorType: error instanceof Error ? error.name : "UnknownError" },
          "Telegram polling stopped after bounded request retries");
      }
      throw error;
    } finally {
      if (this.runtimeHealth) this.runtimeHealth.telegramPollingActive = false;
    }
  }

  private redact(value: string | undefined): string | undefined {
    return value?.replaceAll(this.token, "[REDACTED]").slice(0, 300);
  }

  private safeDiagnostic(value: string | undefined): string | undefined {
    return value
      ?.replaceAll(this.token, "[REDACTED]")
      .replace(/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, "[REDACTED_KEY]")
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED_JWT]")
      .replace(/\b\d{6,}\b/g, "[REDACTED_ID]")
      .slice(0, 300);
  }

  stop(): void {
    this.stopped = true;
    if (this.runtimeHealth) this.runtimeHealth.telegramPollingActive = false;
    this.controller?.abort();
  }
}
