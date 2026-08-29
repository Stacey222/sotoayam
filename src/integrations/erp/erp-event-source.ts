import type { NotificationEvent } from "../../types/index.js";

/**
 * Boundary for a future ERP adapter. ERP-specific payloads should be translated
 * into the stable notification event contract before entering application services.
 */
export interface ErpEventSource {
  toNotificationEvent(payload: unknown): Promise<NotificationEvent | null>;
}
