import type { SupabaseClient } from "@supabase/supabase-js";
import type { DueDelivery } from "./reminders.repository.js";
import { governanceDatabaseError } from "./governance-database-error.js";

export interface NotificationIntakeRecipient {
  legacyId: number;
  dedupeKey: string;
}

export interface NotificationIntakeOutcome {
  eventId: number;
  created: boolean;
  conflict: boolean;
  recipientCount: number;
  routedCount: number;
  dispatched: boolean;
  dispatchSent: number;
  dispatchFailed: number;
}

export interface NotificationDispatchState {
  delivered: number;
  unresolved: number;
  unroutedDedupeKeys: string[];
}

export interface NotificationIntakeRepository {
  intake(input: {
    source: string;
    externalEventId: string;
    identityOrigin: "CALLER" | "GENERATED";
    eventType: string;
    payloadHash: string;
    message: string;
    recipients: NotificationIntakeRecipient[];
    integrationId?: number | null;
  }): Promise<NotificationIntakeOutcome>;
  findDueForEvent(eventId: number, now: string, staleBefore: string, limit: number): Promise<DueDelivery[]>;
  dispatchState(eventId: number): Promise<NotificationDispatchState>;
  completeDispatch(eventId: number, sent: number, failed: number): Promise<void>;
}

interface RpcRow {
  event_id: number;
  created: boolean;
  conflict: boolean;
  recipient_count: number;
  routed_count: number;
  dispatched: boolean;
  dispatch_sent: number;
  dispatch_failed: number;
}

export class SupabaseNotificationIntakeRepository implements NotificationIntakeRepository {
  constructor(private readonly client: SupabaseClient) {}

  async intake(input: Parameters<NotificationIntakeRepository["intake"]>[0]): Promise<NotificationIntakeOutcome> {
    const parameters = {
      p_source: input.source,
      p_external_event_id: input.externalEventId,
      p_identity_origin: input.identityOrigin,
      p_event_type: input.eventType,
      p_payload_hash: input.payloadHash,
      p_message: input.message,
      p_recipients: input.recipients.map((recipient) => ({
        legacy_id: recipient.legacyId,
        dedupe_key: recipient.dedupeKey,
      })),
    };
    const request = input.integrationId === null || input.integrationId === undefined
      ? this.client.rpc("intake_notification_event", parameters)
      : this.client.rpc("intake_attributed_notification_event", { ...parameters, p_integration_id: input.integrationId });
    const { data, error } = await request.single();
    if (error) throw governanceDatabaseError("Unable to persist notification event", error);
    const row = data as unknown as RpcRow;
    return {
      eventId: Number(row.event_id),
      created: row.created,
      conflict: row.conflict,
      recipientCount: Number(row.recipient_count),
      routedCount: Number(row.routed_count),
      dispatched: row.dispatched,
      dispatchSent: Number(row.dispatch_sent),
      dispatchFailed: Number(row.dispatch_failed),
    };
  }

  async findDueForEvent(eventId: number, now: string, staleBefore: string, limit: number): Promise<DueDelivery[]> {
    const { data, error } = await this.client.from("notification_deliveries")
      .select("*,notification:notifications!inner(*)")
      .eq("notification.notification_event_id", eventId)
      .in("state", ["PENDING", "PROCESSING"])
      .lte("next_attempt_at", now)
      .order("next_attempt_at", { ascending: true })
      .limit(limit);
    if (error) throw governanceDatabaseError("Unable to load notification event deliveries", error);
    return ((data ?? []) as unknown as DueDelivery[])
      .filter((row) => row.state === "PENDING" || row.updated_at <= staleBefore);
  }

  async dispatchState(eventId: number): Promise<NotificationDispatchState> {
    const { data, error } = await this.client.from("notifications")
      .select("dedupe_key,routing_status,notification_deliveries(state)")
      .eq("notification_event_id", eventId);
    if (error) throw governanceDatabaseError("Unable to summarize notification event dispatch", error);
    let delivered = 0;
    let unresolved = 0;
    const unroutedDedupeKeys: string[] = [];
    for (const row of data ?? []) {
      if (row.routing_status === "UNROUTED") {
        unroutedDedupeKeys.push(String(row.dedupe_key));
        continue;
      }
      const relation = Array.isArray(row.notification_deliveries)
        ? row.notification_deliveries[0]
        : row.notification_deliveries;
      if (relation?.state === "DELIVERED") delivered += 1;
      else unresolved += 1;
    }
    return { delivered, unresolved, unroutedDedupeKeys };
  }

  async completeDispatch(eventId: number, sent: number, failed: number): Promise<void> {
    const { error } = await this.client.from("notification_events")
      .update({ dispatched_at: new Date().toISOString(), dispatch_sent: sent, dispatch_failed: failed })
      .eq("id", eventId)
      .is("dispatched_at", null);
    if (error) throw governanceDatabaseError("Unable to record notification event dispatch", error);
  }
}
