import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../errors.js";
import type { AuditRepository } from "../repositories/audit.repository.js";
import { governanceDatabaseError } from "../repositories/governance-database-error.js";
import { NOTIFICATION_PREFERENCE_BY_TYPE, type NotificationType } from "../types/index.js";
import type { NotificationIntakeService } from "./notification-intake.service.js";
import type { RecipientResolverService } from "./recipient-resolver.service.js";

const MESSAGE = "[Uji Sotoayam] Notifikasi pengujian dari dashboard administrator.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function notificationType(value: unknown): NotificationType {
  if (typeof value !== "string" || !Object.hasOwn(NOTIFICATION_PREFERENCE_BY_TYPE, value)) {
    throw new AppError(400, "VALIDATION_ERROR", "A supported notification type is required");
  }
  return value as NotificationType;
}
function activeRelation(value: { active: boolean }[] | { active: boolean } | null): boolean {
  return (Array.isArray(value) ? value[0] : value)?.active === true;
}

export class AdminTestNotificationService {
  constructor(private readonly client: SupabaseClient, private readonly resolver: RecipientResolverService,
    private readonly intake: NotificationIntakeService, private readonly audit: AuditRepository) {}

  async recipients(rawType: unknown): Promise<{ id: number; display_name: string }[]> {
    const type = notificationType(rawType);
    const eligible = await this.resolver.resolve(type);
    if (eligible.length === 0) return [];
    const ids = eligible.slice(0, 500).map((item) => item.id);
    const { data, error } = await this.client.from("users")
      .select("id,display_name,legacy_telegram_user_id,divisions(active),roles(active)")
      .in("legacy_telegram_user_id", ids).eq("active", true).limit(500);
    if (error) throw governanceDatabaseError("Unable to load test notification recipients", error);
    return (data ?? []).filter((row) => activeRelation(row.divisions) && activeRelation(row.roles))
      .map((row) => ({ id: row.id, display_name: row.display_name || `Pengguna #${row.id}` }))
      .sort((a, b) => a.id - b.id);
  }

  async send(recipientUserId: number, requestUuid: string, actorUserId: number, requestId: string, rawType: unknown) {
    const type = notificationType(rawType);
    if (!Number.isSafeInteger(recipientUserId) || recipientUserId < 1 || !UUID.test(requestUuid)) {
      throw new AppError(400, "VALIDATION_ERROR", "Valid recipient_user_id and request_id are required");
    }
    const eligible = await this.resolver.resolve(type);
    const legacyIds = eligible.slice(0, 500).map((item) => item.id);
    if (legacyIds.length === 0) throw new AppError(409, "TEST_RECIPIENT_UNAVAILABLE", "No eligible notification recipient is available");
    const { data, error } = await this.client.from("users")
      .select("id,legacy_telegram_user_id,divisions(active),roles(active)")
      .eq("id", recipientUserId).in("legacy_telegram_user_id", legacyIds).eq("active", true).maybeSingle();
    if (error) throw governanceDatabaseError("Unable to verify test notification recipient", error);
    if (!data || !activeRelation(data.divisions) || !activeRelation(data.roles) || data.legacy_telegram_user_id == null) {
      throw new AppError(409, "TEST_RECIPIENT_UNAVAILABLE", "Selected notification recipient is no longer eligible");
    }
    const eventId = `admin-test:${requestUuid.toLowerCase()}`;
    await this.audit.append({ actor_type: "USER", actor_user_id: actorUserId,
      action: "TEST_NOTIFICATION_REQUESTED", object_type: "NOTIFICATION_EVENT", object_id: eventId,
      after_state: { recipient_user_id: recipientUserId, type }, source: "admin_test_notification" });
    const result = await this.intake.send({ event_id: eventId, type, message: MESSAGE,
      metadata: { test_recipient_user_id: recipientUserId } }, null, { requestId }, data.legacy_telegram_user_id);
    if (result.recipients !== 1) throw new AppError(503, "TEST_NOTIFICATION_INCOMPLETE", "Test notification recipient expansion was incomplete");
    return { event_id: eventId, recipient_user_id: recipientUserId, type,
      sent: result.sent, failed: result.failed, duplicate: result.duplicate === true };
  }
}
