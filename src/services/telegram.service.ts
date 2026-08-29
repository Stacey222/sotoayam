import { AppError } from "../errors.js";
import type { FastifyBaseLogger } from "fastify";

export interface TelegramSender {
  sendMessage(chatId: number, message: string): Promise<void>;
}

export class TelegramService implements TelegramSender {
  constructor(
    private readonly botToken: string,
    private readonly logger?: Pick<FastifyBaseLogger, "info">,
  ) {}

  async sendMessage(chatId: number, message: string): Promise<void> {
    const response = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message }),
    });
    if (!response.ok) {
      throw new AppError(502, "TELEGRAM_SEND_FAILED", `Telegram rejected message for chat ${chatId}`);
    }
    this.logger?.info({ telegramChatId: chatId }, "Telegram sendMessage succeeded");
  }
}
