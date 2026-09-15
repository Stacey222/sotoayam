import type { SupabaseClient } from "@supabase/supabase-js";
import type { CriticalAlertPolicy } from "../alerts/policy.js";
import { governanceDatabaseError } from "./governance-database-error.js";

export interface RuntimeSettingsRecord {
  business_time_zone: string | null;
  reminder_scheduler_interval_seconds: number | null;
  critical_alert_policy: CriticalAlertPolicy | null;
  business_actor_user_id: number | null;
  business_actor_display_name: string | null;
  business_actor_eligible: boolean;
  version: number;
  updated_at: string | null;
}

export interface RuntimeSettingsRepository {
  get(): Promise<RuntimeSettingsRecord>;
  updateRuntime(input: { actorUserId: number; expectedVersion: number; businessTimeZone: string;
    reminderSchedulerIntervalSeconds: number; criticalAlertPolicy: CriticalAlertPolicy; reason: string }): Promise<RuntimeSettingsRecord>;
  setBusinessActor(input: { actorUserId: number; expectedVersion: number; userId: number; reason: string }): Promise<RuntimeSettingsRecord>;
}

export class SupabaseRuntimeSettingsRepository implements RuntimeSettingsRepository {
  constructor(private readonly client: SupabaseClient) {}
  async get(): Promise<RuntimeSettingsRecord> { return this.one("get_instance_settings", {}); }
  async updateRuntime(input: Parameters<RuntimeSettingsRepository["updateRuntime"]>[0]): Promise<RuntimeSettingsRecord> {
    return this.one("update_instance_runtime_settings", { p_actor_user_id: input.actorUserId,
      p_expected_version: input.expectedVersion, p_business_time_zone: input.businessTimeZone,
      p_reminder_scheduler_interval_seconds: input.reminderSchedulerIntervalSeconds,
      p_critical_alert_policy: input.criticalAlertPolicy, p_reason: input.reason });
  }
  async setBusinessActor(input: Parameters<RuntimeSettingsRepository["setBusinessActor"]>[0]): Promise<RuntimeSettingsRecord> {
    return this.one("set_instance_business_actor", { p_actor_user_id: input.actorUserId,
      p_expected_version: input.expectedVersion, p_business_actor_user_id: input.userId, p_reason: input.reason });
  }
  private async one(name: string, input: Record<string, unknown>): Promise<RuntimeSettingsRecord> {
    const { data, error } = await this.client.rpc(name, input).single();
    if (error) throw governanceDatabaseError("Unable to access runtime settings", error);
    return data as unknown as RuntimeSettingsRecord;
  }
}
