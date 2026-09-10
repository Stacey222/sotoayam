import { AppError } from "../errors.js";
import type { FastifyBaseLogger } from "fastify";
import { OutboundHttpClient, OutboundHttpError, type OutboundErrorKind } from "../http/outbound-http-client.js";

export interface TelegramSender {
  sendMessage(chatId: number, message: string, options?: TelegramMessageOptions): Promise<void>;
  editMessage?(chatId: number, messageId: number, message: string, options?: TelegramMessageOptions): Promise<void>;
  removeInlineKeyboard?(chatId: number, messageId: number): Promise<void>;
  answerCallbackQuery?(callbackQueryId: string): Promise<void>;
}

export interface TelegramInlineButton {
  text: string;
  callback_data: string;
}

export interface TelegramMessageOptions {
  inlineKeyboard?: TelegramInlineButton[][];
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export class TelegramApiError extends Error {
  constructor(
    public readonly transportKind: OutboundErrorKind | "TELEGRAM",
    public readonly attempts: number,
    public readonly retryable: boolean,
    public readonly retryExhausted: boolean,
    public readonly httpStatus?: number,
    public readonly telegramErrorCode?: number,
    public readonly telegramDescription?: string,
    public readonly retryAfterMs?: number,
  ) {
    super("Telegram API request failed");
    this.name = "TelegramApiError";
  }
}

export interface TelegramApiCallOptions {
  body?: Record<string, unknown>;
  query?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class TelegramApiClient {
  constructor(private readonly http = new OutboundHttpClient()) {}

  async call<T>(botToken: string, method: string, options: TelegramApiCallOptions = {}): Promise<T> {
    const url = new URL(`https://api.telegram.org/bot${botToken}/${method}`);
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
    const isMutation = options.body !== undefined;
    let response: Response;
    try {
      response = await this.http.request(url, {
        method: isMutation ? "POST" : "GET",
        ...(isMutation ? {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(options.body),
          retryMode: "rate-limit-only" as const,
        } : { retryMode: "safe" as const }),
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        retryAfterMs: async (candidate) => {
          const payload = await candidate.json().catch(() => null) as TelegramApiResponse<unknown> | null;
          const seconds = payload?.parameters?.retry_after;
          return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
        },
      });
    } catch (error) {
      if (!(error instanceof OutboundHttpError)) throw error;
      const payload = error.response
        ? await error.response.json().catch(() => null) as TelegramApiResponse<unknown> | null
        : null;
      throw new TelegramApiError(error.kind, error.attempts, error.retryable, error.retryExhausted,
        error.statusCode, payload?.error_code, this.redact(payload?.description, botToken), error.retryAfterMs);
    }
    const payload = await response.json().catch(() => null) as TelegramApiResponse<T> | null;
    if (!payload?.ok || payload.result === undefined) {
      throw new TelegramApiError("TELEGRAM", 1, false, false, response.status,
        payload?.error_code, this.redact(payload?.description, botToken));
    }
    return payload.result;
  }

  private redact(value: string | undefined, botToken: string): string | undefined {
    return value?.replaceAll(botToken, "[REDACTED]").slice(0, 300);
  }
}

export class TelegramOperationError extends AppError {
  constructor(code: string, message: string, public readonly classification: TelegramApiError) {
    super(502, code, message);
    this.name = "TelegramOperationError";
  }
}

export class TelegramService implements TelegramSender {
  constructor(
    private readonly botToken: string,
    private readonly logger?: Pick<FastifyBaseLogger, "info">,
    private readonly api = new TelegramApiClient(),
  ) {}

  async sendMessage(chatId: number, message: string, options?: TelegramMessageOptions): Promise<void> {
    try {
      await this.api.call(this.botToken, "sendMessage", { body: {
        chat_id: chatId,
        text: message,
        ...(options?.inlineKeyboard ? { reply_markup: { inline_keyboard: options.inlineKeyboard } } : {}),
      } });
    } catch (error) {
      if (error instanceof TelegramApiError) {
        throw new TelegramOperationError("TELEGRAM_SEND_FAILED", "Telegram rejected sendMessage request", error);
      }
      throw error;
    }
    this.logger?.info("Telegram sendMessage succeeded");
  }

  async answerCallbackQuery(callbackQueryId: string): Promise<void> {
    try {
      await this.api.call(this.botToken, "answerCallbackQuery", { body: { callback_query_id: callbackQueryId } });
    } catch (error) {
      if (error instanceof TelegramApiError) {
        throw new TelegramOperationError("TELEGRAM_CALLBACK_FAILED", "Telegram rejected callback acknowledgement", error);
      }
      throw error;
    }
    this.logger?.info("Telegram callback acknowledged");
  }

  async editMessage(chatId: number, messageId: number, message: string, options?: TelegramMessageOptions): Promise<void> {
    try {
      await this.api.call(this.botToken, "editMessageText", { body: {
        chat_id: chatId,
        message_id: messageId,
        text: message,
        reply_markup: { inline_keyboard: options?.inlineKeyboard ?? [] },
      } });
    } catch (error) {
      if (error instanceof TelegramApiError) {
        throw new TelegramOperationError("TELEGRAM_EDIT_FAILED", "Telegram rejected editMessageText request", error);
      }
      throw error;
    }
    this.logger?.info("Telegram editMessageText succeeded");
  }

  async removeInlineKeyboard(chatId: number, messageId: number): Promise<void> {
    try {
      await this.api.call(this.botToken, "editMessageReplyMarkup", { body: {
        chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] },
      } });
    } catch (error) {
      if (error instanceof TelegramApiError) {
        throw new TelegramOperationError("TELEGRAM_MARKUP_EDIT_FAILED", "Telegram rejected reply markup edit", error);
      }
      throw error;
    }
    this.logger?.info("Telegram stale inline keyboard removed");
  }
}
