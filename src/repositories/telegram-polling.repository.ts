import type { SupabaseClient } from "@supabase/supabase-js";
import { governanceDatabaseError } from "./governance-database-error.js";

export type TelegramUpdateType = "message" | "callback_query" | "other";
export type TelegramUpdateClaimAction = "PROCESS" | "SKIP_DUPLICATE" | "SKIP_EXHAUSTED";
export type TelegramUpdateTerminalStatus = "COMPLETED" | "FAILED";

export interface TelegramUpdateClaim {
  action: TelegramUpdateClaimAction;
  attemptCount: number;
}

export interface TelegramPollingRepository {
  loadPollingState(): Promise<number>;
  claim(updateId: number, updateType: TelegramUpdateType, maxAttempts: number): Promise<TelegramUpdateClaim>;
  complete(updateId: number, status: TelegramUpdateTerminalStatus, failureClass: string | null,
    retentionDays: number): Promise<number>;
}

function firstRow<T>(value: unknown): T | null {
  if (Array.isArray(value)) return (value[0] as T | undefined) ?? null;
  return value && typeof value === "object" ? value as T : null;
}

export class SupabaseTelegramPollingRepository implements TelegramPollingRepository {
  constructor(private readonly client: SupabaseClient) {}

  async loadPollingState(): Promise<number> {
    const { data, error } = await this.client.rpc("load_telegram_polling_state");
    if (error) throw governanceDatabaseError("Unable to load Telegram polling state", error);
    const offset = Number(data);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Telegram polling state returned an invalid offset");
    return offset;
  }

  async claim(updateId: number, updateType: TelegramUpdateType, maxAttempts: number): Promise<TelegramUpdateClaim> {
    const { data, error } = await this.client.rpc("claim_telegram_update", {
      p_update_id: updateId,
      p_update_type: updateType,
      p_max_attempts: maxAttempts,
    });
    if (error) throw governanceDatabaseError("Unable to claim Telegram update", error);
    const row = firstRow<{ action: TelegramUpdateClaimAction; attempt_count: number }>(data);
    if (!row) throw new Error("Telegram update claim returned no row");
    return { action: row.action, attemptCount: Number(row.attempt_count) };
  }

  async complete(updateId: number, status: TelegramUpdateTerminalStatus, failureClass: string | null,
    retentionDays: number): Promise<number> {
    const { data, error } = await this.client.rpc("complete_telegram_update", {
      p_update_id: updateId,
      p_status: status,
      p_failure_class: failureClass,
      p_retention_days: retentionDays,
    });
    if (error) throw governanceDatabaseError("Unable to complete Telegram update", error);
    const offset = Number(data);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Telegram update completion returned an invalid offset");
    return offset;
  }
}
