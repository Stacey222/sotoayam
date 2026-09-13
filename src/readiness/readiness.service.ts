import type { SupabaseClient } from "@supabase/supabase-js";

export type ReadinessCheck = "PASS" | "FAIL" | "TIMEOUT" | "SKIPPED";
export type ReadinessWarning =
  | "TELEGRAM_POLLING_INACTIVE"
  | "REMINDER_SCHEDULER_INACTIVE"
  | "ALERT_EVALUATOR_INACTIVE";

export interface ReadinessResult {
  ready: boolean;
  status: "READY" | "NOT_READY";
  checks: { database: ReadinessCheck; schema: ReadinessCheck; core_routes: ReadinessCheck };
  warnings: ReadinessWarning[];
  observed_at: string;
}

export interface ReadinessProbe {
  run(signal: AbortSignal): Promise<{ database: "PASS" | "FAIL"; schema: "PASS" | "FAIL" | "SKIPPED" }>;
}

export interface ReadinessWiring {
  adminSessionAuthentication: boolean;
  persistedNotificationIntake: boolean;
  telegramPolling: { enabled: boolean; active: () => boolean };
  reminderScheduler: { enabled: boolean; active: () => boolean };
  alertEvaluator: { enabled: boolean; active: () => boolean };
}

export class SupabaseReadinessProbe implements ReadinessProbe {
  constructor(private readonly client: SupabaseClient) {}

  async run(signal: AbortSignal): Promise<{ database: "PASS" | "FAIL"; schema: "PASS" | "FAIL" | "SKIPPED" }> {
    const { data, error } = await this.client.rpc("load_telegram_polling_state").abortSignal(signal);
    if (error) {
      // A PostgREST error code proves the database answered but the required
      // schema contract failed. A transport error cannot prove schema state.
      return error.code ? { database: "PASS", schema: "FAIL" } : { database: "FAIL", schema: "SKIPPED" };
    }
    const offset = typeof data === "number" || (typeof data === "string" && /^\d+$/.test(data)) ? Number(data) : Number.NaN;
    return Number.isSafeInteger(offset) && offset >= 0
      ? { database: "PASS", schema: "PASS" }
      : { database: "PASS", schema: "FAIL" };
  }
}

export class UnavailableReadinessProbe implements ReadinessProbe {
  async run(): Promise<{ database: "FAIL"; schema: "SKIPPED" }> {
    return { database: "FAIL", schema: "SKIPPED" };
  }
}

export class ReadinessService {
  private cached?: { expiresAt: number; result: ReadinessResult };
  private inFlight?: Promise<ReadinessResult>;

  constructor(
    private readonly probe: ReadinessProbe,
    private readonly wiring: ReadinessWiring,
    private readonly timeoutMs: number,
    private readonly cacheMs: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  check(): Promise<ReadinessResult> {
    const current = this.now().getTime();
    if (this.cached && current < this.cached.expiresAt) return Promise.resolve(this.cached.result);
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.evaluate().then((result) => {
      this.cached = { expiresAt: this.now().getTime() + this.cacheMs, result };
      return result;
    }).finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async evaluate(): Promise<ReadinessResult> {
    const observedAt = this.now().toISOString();
    const controller = new AbortController();
    let timedOut = false;
    let rejectTimeout: (() => void) | undefined;
    const timeout = new Promise<never>((_resolve, reject) => { rejectTimeout = () => reject(new Error("READINESS_TIMEOUT")); });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); rejectTimeout?.(); }, this.timeoutMs);
    timer.unref?.();
    let database: ReadinessCheck = "FAIL";
    let schema: ReadinessCheck = "SKIPPED";
    try {
      const result = await Promise.race([this.probe.run(controller.signal), timeout]);
      database = result.database;
      schema = result.schema;
    } catch {
      if (timedOut || controller.signal.aborted) database = "TIMEOUT";
    } finally {
      clearTimeout(timer);
    }

    try {
      const coreRoutes: ReadinessCheck = this.wiring.adminSessionAuthentication
        && this.wiring.persistedNotificationIntake ? "PASS" : "FAIL";
      const warnings: ReadinessWarning[] = [];
      if (this.wiring.telegramPolling.enabled && !this.wiring.telegramPolling.active()) warnings.push("TELEGRAM_POLLING_INACTIVE");
      if (this.wiring.reminderScheduler.enabled && !this.wiring.reminderScheduler.active()) warnings.push("REMINDER_SCHEDULER_INACTIVE");
      if (this.wiring.alertEvaluator.enabled && !this.wiring.alertEvaluator.active()) warnings.push("ALERT_EVALUATOR_INACTIVE");
      const ready = database === "PASS" && schema === "PASS" && coreRoutes === "PASS";
      return { ready, status: ready ? "READY" : "NOT_READY",
        checks: { database, schema, core_routes: coreRoutes }, warnings, observed_at: observedAt };
    } catch {
      return readinessFailure(observedAt);
    }
  }
}

export function readinessFailure(observedAt = new Date().toISOString()): ReadinessResult {
  return { ready: false, status: "NOT_READY",
    checks: { database: "FAIL", schema: "SKIPPED", core_routes: "FAIL" }, warnings: [], observed_at: observedAt };
}
