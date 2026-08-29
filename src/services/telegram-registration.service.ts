import type { TelegramRegistration, TelegramUser } from "../types/index.js";

export interface TelegramRegistrationWriter {
  upsertTelegramRegistration(registration: TelegramRegistration): Promise<TelegramUser>;
}

export class TelegramRegistrationService {
  constructor(private readonly writer: TelegramRegistrationWriter) {}

  register(registration: TelegramRegistration): Promise<TelegramUser> {
    return this.writer.upsertTelegramRegistration(registration);
  }
}
