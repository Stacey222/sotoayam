import type { FastifyBaseLogger } from "fastify";
import { DatabaseError } from "../errors.js";
import type { TelegramUsersRepository } from "../repositories/telegram-users.repository.js";
import type { TelegramSender } from "../services/telegram.service.js";

interface TelegramUpdate {
  update_id: number;
  message?: {
    text?: string;
    chat: { id: number; username?: string; first_name?: string };
    from?: { username?: string; first_name?: string };
  };
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
}

class TelegramPollingError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly telegramErrorCode?: number,
    public readonly telegramDescription?: string,
  ) {
    super("Telegram polling request was rejected");
    this.name = "TelegramPollingError";
  }
}

export class TelegramBot {
  private offset = 0;
  private stopped = false;
  private controller?: AbortController;

  constructor(
    private readonly token: string,
    private readonly repository: TelegramUsersRepository,
    private readonly sender: TelegramSender,
    private readonly logger: Pick<FastifyBaseLogger, "info" | "warn" | "error">,
  ) {}

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message || !/^\/start(?:@\w+)?(?:\s|$)/i.test(message.text ?? "")) return;
    this.logger.info({ updateId: update.update_id, telegramChatId: message.chat.id }, "Telegram /start received");
    const username = message.from?.username ?? message.chat.username ?? null;
    const firstName = message.from?.first_name ?? message.chat.first_name ?? null;
    try {
      await this.repository.upsertTelegramRegistration({
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
          telegramChatId: message.chat.id,
        },
        "Telegram registration failed",
      );
      try {
        await this.sender.sendMessage(
          message.chat.id,
          "Registrasi Telegram Gwens belum dapat diproses. Silakan coba lagi beberapa saat atau hubungi Admin Gwens.",
        );
      } catch (sendError) {
        this.logger.error(
          {
            errorType: sendError instanceof Error ? sendError.name : "UnknownError",
            updateId: update.update_id,
            telegramChatId: message.chat.id,
          },
          "Telegram registration failure message could not be sent",
        );
      }
      return;
    }
    this.logger.info({ updateId: update.update_id, telegramChatId: message.chat.id }, "Telegram registration succeeded");
    const usernameLine = username ? `\nUsername: @${username}` : "";
    await this.sender.sendMessage(
      message.chat.id,
      `Registrasi Telegram Gwens berhasil.\n\nNama: ${firstName ?? "-"}${usernameLine}\n\nStatus: Menunggu aktivasi Admin.\n\nSilakan hubungi Admin Gwens untuk menentukan Divisi dan Role Anda.`,
    );
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.logger.info("Telegram bot initialization started");
    const me = await this.callTelegram<{ username?: string }>("getMe");
    this.logger.info({ botUsername: me.username ?? null }, "Telegram getMe succeeded");
    this.logger.info("Telegram polling started");
    while (!this.stopped) {
      this.controller = new AbortController();
      try {
        const url = new URL(`https://api.telegram.org/bot${this.token}/getUpdates`);
        url.searchParams.set("offset", String(this.offset));
        url.searchParams.set("timeout", "25");
        url.searchParams.set("allowed_updates", JSON.stringify(["message"]));
        const response = await fetch(url, { signal: this.controller.signal });
        const payload = (await response.json().catch(() => ({ ok: false }))) as TelegramApiResponse<TelegramUpdate[]>;
        if (!response.ok || !payload.ok) {
          throw new TelegramPollingError(
            response.status,
            payload.error_code,
            this.redact(payload.description),
          );
        }
        for (const update of payload.result ?? []) {
          this.offset = update.update_id + 1;
          this.logger.info(
            { updateId: update.update_id, hasMessage: Boolean(update.message) },
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
      } catch (error) {
        if (this.stopped) break;
        if (error instanceof TelegramPollingError) {
          this.logger.warn(
            {
              httpStatus: error.httpStatus,
              telegramErrorCode: error.telegramErrorCode,
              telegramDescription: error.telegramDescription,
            },
            "Telegram polling error; retrying",
          );
        } else {
          this.logger.warn(
            { errorType: error instanceof Error ? error.name : "UnknownError" },
            "Telegram polling error; retrying",
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  private async callTelegram<T>(method: string): Promise<T> {
    const response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`);
    const payload = (await response.json().catch(() => ({ ok: false }))) as TelegramApiResponse<T>;
    if (!response.ok || !payload.ok || payload.result === undefined) {
      throw new TelegramPollingError(response.status, payload.error_code, this.redact(payload.description));
    }
    return payload.result;
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
    this.controller?.abort();
  }
}
