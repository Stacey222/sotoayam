import type { TelegramUsersRepository } from "../repositories/telegram-users.repository.js";
import {
  NOTIFICATION_PREFERENCE_BY_TYPE,
  type NotificationType,
  type TelegramUser,
} from "../types/index.js";

export class RecipientResolverService {
  constructor(private readonly usersRepository: TelegramUsersRepository) {}

  resolve(type: NotificationType): Promise<TelegramUser[]> {
    return this.usersRepository.findRecipientsForNotification(NOTIFICATION_PREFERENCE_BY_TYPE[type]);
  }
}
