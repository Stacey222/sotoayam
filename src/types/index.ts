export const NOTIFICATION_PREFERENCE_BY_TYPE = {
  STOCK_CRITICAL: "stock_alert",
  PURCHASE_RECOMMENDATION: "purchase_alert",
  SALES_FOLLOWUP: "sales_alert",
  MARKETING_ALERT: "marketing_alert",
  CONTENT_OPPORTUNITY: "content_alert",
  OWNER_DAILY_REPORT: "owner_report",
  SYSTEM_ERROR: "system_error",
} as const;

export const NOTIFICATION_PREFERENCES = [
  "stock_alert",
  "purchase_alert",
  "sales_alert",
  "marketing_alert",
  "content_alert",
  "owner_report",
  "system_error",
] as const;

export type NotificationType = keyof typeof NOTIFICATION_PREFERENCE_BY_TYPE;
export type NotificationPreference = (typeof NOTIFICATION_PREFERENCES)[number];

export interface TelegramUser {
  id: number;
  telegram_chat_id: number;
  telegram_username: string | null;
  telegram_first_name: string | null;
  name: string | null;
  division: string;
  role: string;
  active: boolean;
  stock_alert: boolean;
  purchase_alert: boolean;
  sales_alert: boolean;
  marketing_alert: boolean;
  content_alert: boolean;
  owner_report: boolean;
  system_error: boolean;
  created_at: string;
  updated_at: string;
}

export type TelegramRegistration = Pick<
  TelegramUser,
  "telegram_chat_id" | "telegram_username" | "telegram_first_name"
>;

export type UserUpdate = Partial<
  Pick<
    TelegramUser,
    | "name"
    | "division"
    | "role"
    | "active"
    | "stock_alert"
    | "purchase_alert"
    | "sales_alert"
    | "marketing_alert"
    | "content_alert"
    | "owner_report"
    | "system_error"
  >
>;

export interface UserFilters {
  status?: "pending" | "active" | "inactive";
  division?: string;
  active?: boolean;
}

export interface NotificationEvent {
  event_id?: string;
  type: NotificationType;
  message: string;
  metadata?: Record<string, unknown>;
}
