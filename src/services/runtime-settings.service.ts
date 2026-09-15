import { AppError, DatabaseError } from "../errors.js";
import { validateCriticalAlertPolicy, type CriticalAlertPolicy } from "../alerts/policy.js";
import type { RuntimeSettingsRecord, RuntimeSettingsRepository } from "../repositories/runtime-settings.repository.js";
import { RuntimeSettingsProvider, type RuntimeSettingsSnapshot } from "../runtime/runtime-settings.js";
import type { TaskActor } from "../tasks/types.js";

export interface RuntimeSettingsDto {
  version: number;
  runtime: { business_time_zone: string; reminder_scheduler_interval_seconds: number; critical_alert_policy: CriticalAlertPolicy };
  source: "DEPLOYMENT_DEFAULT" | "RUNTIME";
  business_actor: { id: number; display_name: string | null } | null;
  updated_at: string | null;
}

export class RuntimeSettingsService {
  private record!: RuntimeSettingsRecord;
  private onIntervalChange?: (seconds: number) => void;
  constructor(private readonly repository: RuntimeSettingsRepository, readonly provider: RuntimeSettingsProvider,
    private readonly baseline: RuntimeSettingsSnapshot) {}

  async load(): Promise<void> { this.record = await this.repository.get(); this.provider.apply(this.snapshot(this.record)); }
  setIntervalUpdater(update: (seconds: number) => void): void { this.onIntervalChange = update; }
  current(actor: TaskActor, effectiveSystemAdmin: boolean): RuntimeSettingsDto {
    if (!effectiveSystemAdmin && !actor.permissions.has("threshold.manage")) this.forbidden();
    return this.dto(this.record);
  }
  async updateRuntime(actor: TaskActor, input: { expectedVersion: number; businessTimeZone: string;
    reminderSchedulerIntervalSeconds: number; criticalAlertPolicy: unknown; reason: string }): Promise<RuntimeSettingsDto> {
    if (!actor.permissions.has("threshold.manage")) this.forbidden();
    const validated = validateRuntimeInput(input);
    try {
      const next = await this.repository.updateRuntime({ actorUserId: actor.id, ...validated });
      this.record = next; const snapshot = this.snapshot(next); this.provider.apply(snapshot);
      this.onIntervalChange?.(snapshot.reminderSchedulerIntervalSeconds);
      return this.dto(next);
    } catch (error) { throw mapSettingsError(error); }
  }
  async setBusinessActor(actor: TaskActor, input: { expectedVersion: number; userId: number; reason: string }): Promise<RuntimeSettingsDto> {
    try { this.record = await this.repository.setBusinessActor({ actorUserId: actor.id, ...input }); return this.dto(this.record); }
    catch (error) { throw mapSettingsError(error); }
  }
  private snapshot(record: RuntimeSettingsRecord): RuntimeSettingsSnapshot {
    const allPersisted = record.business_time_zone !== null && record.reminder_scheduler_interval_seconds !== null
      && record.critical_alert_policy !== null;
    return allPersisted ? { businessTimeZone: record.business_time_zone!,
      reminderSchedulerIntervalSeconds: record.reminder_scheduler_interval_seconds!,
      criticalAlertPolicy: record.critical_alert_policy! } : this.baseline;
  }
  private dto(record: RuntimeSettingsRecord): RuntimeSettingsDto {
    const value = this.snapshot(record);
    return { version: record.version, runtime: { business_time_zone: value.businessTimeZone,
      reminder_scheduler_interval_seconds: value.reminderSchedulerIntervalSeconds,
      critical_alert_policy: value.criticalAlertPolicy },
      source: record.business_time_zone === null ? "DEPLOYMENT_DEFAULT" : "RUNTIME",
      business_actor: record.business_actor_user_id === null ? null : {
        id: record.business_actor_user_id, display_name: record.business_actor_display_name }, updated_at: record.updated_at };
  }
  private forbidden(): never { throw new AppError(403, "RUNTIME_SETTINGS_FORBIDDEN", "Required business settings permission is unavailable"); }
}

export function validTimeZone(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 100 || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new AppError(400, "VALIDATION_ERROR", "business_time_zone must be a valid IANA timezone");
  }
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0)); }
  catch { throw new AppError(400, "VALIDATION_ERROR", "business_time_zone must be a valid IANA timezone"); }
  return value;
}

function validateRuntimeInput(input: { expectedVersion: number; businessTimeZone: string; reminderSchedulerIntervalSeconds: number;
  criticalAlertPolicy: unknown; reason: string }) {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw new AppError(400, "VALIDATION_ERROR", "expected_version is invalid");
  if (!Number.isSafeInteger(input.reminderSchedulerIntervalSeconds) || input.reminderSchedulerIntervalSeconds < 60
    || input.reminderSchedulerIntervalSeconds > 3600) throw new AppError(400, "VALIDATION_ERROR", "reminder_scheduler_interval_seconds must be an integer from 60 to 3600");
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 1 || reason.length > 500) throw new AppError(400, "VALIDATION_ERROR", "reason must contain 1-500 characters");
  let policy: CriticalAlertPolicy;
  try { policy = validateCriticalAlertPolicy(input.criticalAlertPolicy); }
  catch { throw new AppError(400, "VALIDATION_ERROR", "critical_alert_policy is invalid"); }
  return { expectedVersion: input.expectedVersion, businessTimeZone: validTimeZone(input.businessTimeZone),
    reminderSchedulerIntervalSeconds: input.reminderSchedulerIntervalSeconds, criticalAlertPolicy: policy, reason };
}

function mapSettingsError(error: unknown): never {
  if (error instanceof AppError && !(error instanceof DatabaseError)) throw error;
  const message = error instanceof DatabaseError ? error.diagnostic.message ?? "" : error instanceof Error ? error.message : "";
  if (message.includes("SETTINGS_VERSION_CONFLICT")) throw new AppError(409, "SETTINGS_VERSION_CONFLICT", "Runtime settings changed; reload and try again");
  if (message.includes("SETTINGS_UNCHANGED")) throw new AppError(409, "SETTINGS_UNCHANGED", "The requested settings are unchanged");
  if (message.includes("BUSINESS_ACTOR_INELIGIBLE")) throw new AppError(409, "BUSINESS_ACTOR_INELIGIBLE", "The selected business actor is not eligible");
  if (message.includes("RUNTIME_SETTINGS_FORBIDDEN")) throw new AppError(403, "RUNTIME_SETTINGS_FORBIDDEN", "Required business settings permission is unavailable");
  if (message.includes("SYSTEM_ADMIN_REQUIRED")) throw new AppError(403, "ADMIN_AUTHORITY_REQUIRED", "Active SYSTEM_ADMIN authority is required");
  throw error;
}
