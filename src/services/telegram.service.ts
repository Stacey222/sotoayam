import { AppError } from "../errors.js";
import type { FastifyBaseLogger } from "fastify";

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

export class TelegramDeliveryError extends AppError {
  constructor(code: "TELEGRAM_RATE_LIMITED" | "TELEGRAM_SEND_TRANSIENT" | "TELEGRAM_SEND_PERMANENT", public readonly retryAfterSeconds?: number) {
    super(502, code, "Telegram delivery failed");
  }
}

export class TelegramService implements TelegramSender {
  constructor(
    private readonly botToken: string,
    private readonly logger?: Pick<FastifyBaseLogger, "info">,
  ) {}

  async sendMessage(chatId: number, message: string, options?: TelegramMessageOptions): Promise<void> {
    try {
      const response = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: "POST", signal: AbortSignal.timeout(15_000), headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: message,
          ...(options?.inlineKeyboard ? { reply_markup: { inline_keyboard: options.inlineKeyboard } } : {}) }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { parameters?: { retry_after?: unknown } } | null;
        const retryAfter = typeof body?.parameters?.retry_after === "number" && Number.isInteger(body.parameters.retry_after) && body.parameters.retry_after > 0 ? body.parameters.retry_after : undefined;
        if (response.status === 429) throw new TelegramDeliveryError("TELEGRAM_RATE_LIMITED", retryAfter);
        if (response.status >= 500) throw new TelegramDeliveryError("TELEGRAM_SEND_TRANSIENT");
        throw new TelegramDeliveryError("TELEGRAM_SEND_PERMANENT");
      }
    } catch (error) {
      if (error instanceof TelegramDeliveryError) throw error;
      throw new TelegramDeliveryError("TELEGRAM_SEND_TRANSIENT");
    }
    this.logger?.info("Telegram sendMessage succeeded");
  }

  async answerCallbackQuery(callbackQueryId: string): Promise<void> {
    const response = await fetch(`https://api.telegram.org/bot${this.botToken}/answerCallbackQuery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId }),
    });
    if (!response.ok) throw new AppError(502, "TELEGRAM_CALLBACK_FAILED", "Telegram rejected callback acknowledgement");
    this.logger?.info("Telegram callback acknowledged");
  }

  async editMessage(chatId: number, messageId: number, message: string, options?: TelegramMessageOptions): Promise<void> {
    const response = await fetch(`https://api.telegram.org/bot${this.botToken}/editMessageText`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: message,
        reply_markup: { inline_keyboard: options?.inlineKeyboard ?? [] },
      }),
    });
    if (!response.ok) throw new AppError(502, "TELEGRAM_EDIT_FAILED", "Telegram rejected editMessageText request");
    this.logger?.info("Telegram editMessageText succeeded");
  }

  async removeInlineKeyboard(chatId: number, messageId: number): Promise<void> {
    const response = await fetch(`https://api.telegram.org/bot${this.botToken}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
    });
    if (!response.ok) throw new AppError(502, "TELEGRAM_MARKUP_EDIT_FAILED", "Telegram rejected reply markup edit");
    this.logger?.info("Telegram stale inline keyboard removed");
  }
}
