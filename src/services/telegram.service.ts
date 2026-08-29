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

export class TelegramService implements TelegramSender {
  constructor(
    private readonly botToken: string,
    private readonly logger?: Pick<FastifyBaseLogger, "info">,
  ) {}

  async sendMessage(chatId: number, message: string, options?: TelegramMessageOptions): Promise<void> {
    const response = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        ...(options?.inlineKeyboard ? { reply_markup: { inline_keyboard: options.inlineKeyboard } } : {}),
      }),
    });
    if (!response.ok) {
      throw new AppError(502, "TELEGRAM_SEND_FAILED", "Telegram rejected sendMessage request");
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
