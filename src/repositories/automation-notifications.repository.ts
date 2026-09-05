import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../errors.js";
import { governanceDatabaseError } from "./governance-database-error.js";
import type { TelegramUser } from "../types/index.js";

export type AutomationDeliveryState = "PENDING" | "PROCESSING" | "DELIVERED" | "FAILED";
export type AutomationFailureClass = "TRANSIENT" | "PERMANENT";

export interface AutomationDelivery {
  id: number;
  event_id: number;
  recipient_telegram_user_id: number;
  telegram_chat_id: number;
  state: AutomationDeliveryState;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
  updated_at: string;
}

export interface AutomationNotificationRepository {
  createOrGet(input: { eventId: string | undefined; type: string; message: string; recipients: TelegramUser[] }): Promise<{ eventId: number; created: boolean }>;
  findDue(eventId: number, now: string, staleBefore: string): Promise<AutomationDelivery[]>;
  claim(delivery: AutomationDelivery): Promise<AutomationDelivery | null>;
  markDelivered(id: number, attemptCount: number, deliveredAt: string): Promise<void>;
  markFailed(id: number, input: { state: "PENDING" | "FAILED"; attemptCount: number; nextAttemptAt: string | null; failureClass: AutomationFailureClass; failureCode: string }): Promise<void>;
  status(eventId: number): Promise<{ requested: number; sent: number; pending: number; failed: number; retryAt: string | null }>;
}

export class SupabaseAutomationNotificationRepository implements AutomationNotificationRepository {
  constructor(private readonly client: SupabaseClient) {}

  async createOrGet(input: { eventId: string | undefined; type: string; message: string; recipients: TelegramUser[] }): Promise<{ eventId: number; created: boolean }> {
    const payloadHash = createHash("sha256").update(`${input.type}\n${input.message}`).digest("hex");
    const { data, error } = await this.client.rpc("create_automation_notification_event", {
      p_external_event_id: input.eventId ?? null,
      p_event_type: input.type,
      p_message: input.message,
      p_payload_hash: payloadHash,
      p_recipients: input.recipients.map((recipient) => ({ telegram_user_id: recipient.id, telegram_chat_id: recipient.telegram_chat_id })),
    }).single();
    if (error) {
      if (error.message.includes("Conflicting automation notification event")) {
        throw new AppError(409, "NOTIFICATION_EVENT_CONFLICT", "event_id was reused with different notification content");
      }
      throw governanceDatabaseError("Unable to persist automation notification event", error);
    }
    const row = data as { event_id: number; created: boolean };
    return { eventId: Number(row.event_id), created: row.created };
  }

  async findDue(eventId: number, now: string, staleBefore: string): Promise<AutomationDelivery[]> {
    const { data, error } = await this.client.from("automation_notification_deliveries").select("*")
      .eq("event_id", eventId).in("state", ["PENDING", "PROCESSING"]).lte("next_attempt_at", now).order("next_attempt_at", { ascending: true });
    if (error) throw governanceDatabaseError("Unable to load automation notification deliveries", error);
    return ((data ?? []) as AutomationDelivery[]).filter((item) => item.state === "PENDING" || item.updated_at <= staleBefore);
  }

  async claim(delivery: AutomationDelivery): Promise<AutomationDelivery | null> {
    const { data, error } = await this.client.from("automation_notification_deliveries").update({ state: "PROCESSING" })
      .eq("id", delivery.id).eq("state", delivery.state).eq("attempt_count", delivery.attempt_count).eq("updated_at", delivery.updated_at).select("*").maybeSingle();
    if (error) throw governanceDatabaseError("Unable to claim automation notification delivery", error);
    return data as AutomationDelivery | null;
  }

  async markDelivered(id: number, attemptCount: number, deliveredAt: string): Promise<void> {
    const { error } = await this.client.from("automation_notification_deliveries").update({ state: "DELIVERED", attempt_count: attemptCount, next_attempt_at: null, delivered_at: deliveredAt, failure_class: null, failure_code: null }).eq("id", id);
    if (error) throw governanceDatabaseError("Unable to record automation notification delivery", error);
  }

  async markFailed(id: number, input: { state: "PENDING" | "FAILED"; attemptCount: number; nextAttemptAt: string | null; failureClass: AutomationFailureClass; failureCode: string }): Promise<void> {
    const { error } = await this.client.from("automation_notification_deliveries").update({ state: input.state, attempt_count: input.attemptCount, next_attempt_at: input.nextAttemptAt, delivered_at: null, failure_class: input.failureClass, failure_code: input.failureCode }).eq("id", id);
    if (error) throw governanceDatabaseError("Unable to record automation notification failure", error);
  }

  async status(eventId: number): Promise<{ requested: number; sent: number; pending: number; failed: number; retryAt: string | null }> {
    const { data, error } = await this.client.from("automation_notification_deliveries").select("state,next_attempt_at").eq("event_id", eventId);
    if (error) throw governanceDatabaseError("Unable to summarize automation notification", error);
    const rows = (data ?? []) as Array<{ state: AutomationDeliveryState; next_attempt_at: string | null }>;
    const retryAt = rows.filter((item) => item.state === "PENDING" && item.next_attempt_at).map((item) => item.next_attempt_at!).sort()[0] ?? null;
    return { requested: rows.length, sent: rows.filter((item) => item.state === "DELIVERED").length,
      pending: rows.filter((item) => item.state === "PENDING" || item.state === "PROCESSING").length,
      failed: rows.filter((item) => item.state === "FAILED").length, retryAt };
  }
}
