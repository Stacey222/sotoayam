import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ReadinessService, SupabaseReadinessProbe, type ReadinessProbe, type ReadinessWiring,
} from "../../src/readiness/readiness.service.js";
import { healthRoutes } from "../../src/routes/health.routes.js";

const passProbe = (): ReadinessProbe => ({ run: vi.fn().mockResolvedValue({ database: "PASS", schema: "PASS" }) });
const wiring = (overrides: Partial<ReadinessWiring> = {}): ReadinessWiring => ({
  adminSessionAuthentication: true,
  persistedNotificationIntake: true,
  telegramPolling: { enabled: false, active: () => false },
  reminderScheduler: { enabled: false, active: () => false },
  alertEvaluator: { enabled: false, active: () => false },
  ...overrides,
});
const service = (probe = passProbe(), state = wiring(), timeout = 2_000, cache = 1_000,
  now: () => Date = () => new Date("2026-09-12T00:00:00.000Z")) => new ReadinessService(probe, state, timeout, cache, now);

async function appFor(readiness: { check: () => Promise<unknown> }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(healthRoutes, { readiness: readiness as never });
  return app;
}

afterEach(() => vi.useRealTimers());

describe("P1-07 meaningful readiness", () => {
  it("R-01 returns the exact READY contract when all hard gates pass", async () => {
    const app = await appFor(service());
    const response = await app.inject("/ready");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ready: true, status: "READY",
      checks: { database: "PASS", schema: "PASS", core_routes: "PASS" }, warnings: [],
      observed_at: "2026-09-12T00:00:00.000Z" });
    await app.close();
  });

  it("R-02 keeps liveness healthy when the database readiness gate fails", async () => {
    const probe = { run: vi.fn().mockResolvedValue({ database: "FAIL", schema: "SKIPPED" }) };
    const app = await appFor(service(probe));
    expect((await app.inject("/ready")).statusCode).toBe(503);
    expect((await app.inject("/health")).json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("R-03 fails closed when the required schema probe fails", async () => {
    const result = await service({ run: async () => ({ database: "PASS", schema: "FAIL" }) }).check();
    expect(result).toMatchObject({ ready: false, status: "NOT_READY", checks: { database: "PASS", schema: "FAIL" } });
  });

  it("R-04 fails when admin session authentication is not wired", async () => {
    expect((await service(passProbe(), wiring({ adminSessionAuthentication: false })).check()).checks.core_routes).toBe("FAIL");
  });

  it("R-05 fails when persisted notification intake is not wired", async () => {
    expect((await service(passProbe(), wiring({ persistedNotificationIntake: false })).check()).ready).toBe(false);
  });

  it("R-06 bounds and aborts a probe that does not settle", async () => {
    vi.useFakeTimers();
    let captured: AbortSignal | undefined;
    const pending: ReadinessProbe = { run: (signal) => { captured = signal; return new Promise(() => undefined); } };
    const resultPromise = service(pending, wiring(), 250).check();
    await vi.advanceTimersByTimeAsync(250);
    await expect(resultPromise).resolves.toMatchObject({ ready: false, checks: { database: "TIMEOUT", schema: "SKIPPED" } });
    expect(captured?.aborted).toBe(true);
  });

  it("R-07 performs one probe attempt with no retry", async () => {
    const run = vi.fn().mockRejectedValue(new Error("offline"));
    expect((await service({ run }).check()).ready).toBe(false);
    expect(run).toHaveBeenCalledOnce();
  });

  it("R-08 caches repeated readiness requests and shares the observed result", async () => {
    const probe = passProbe(); const readiness = service(probe);
    const results = await Promise.all(Array.from({ length: 25 }, () => readiness.check()));
    expect(probe.run).toHaveBeenCalledOnce();
    expect(new Set(results.map((result) => result.observed_at)).size).toBe(1);
  });

  it("R-09 probes again after cache expiry", async () => {
    let milliseconds = 0;
    const probe = passProbe();
    const readiness = service(probe, wiring(), 2_000, 1_000, () => new Date(milliseconds));
    await readiness.check(); milliseconds = 1_001; await readiness.check();
    expect(probe.run).toHaveBeenCalledTimes(2);
  });

  it("bounds a cached NOT_READY result to one second and observes recovery before the next deployment poll", async () => {
    let milliseconds = 0;
    const probe = { run: vi.fn().mockResolvedValueOnce({ database: "FAIL", schema: "SKIPPED" })
      .mockResolvedValueOnce({ database: "PASS", schema: "PASS" }) };
    const readiness = service(probe, wiring(), 2_000, 1_000, () => new Date(milliseconds));
    expect((await readiness.check()).status).toBe("NOT_READY");
    milliseconds = 999;
    expect((await readiness.check()).status).toBe("NOT_READY");
    expect(probe.run).toHaveBeenCalledOnce();
    milliseconds = 2_000;
    expect((await readiness.check()).status).toBe("READY");
    expect(probe.run).toHaveBeenCalledTimes(2);
  });

  it("R-10 supports disabling the cache with zero milliseconds", async () => {
    let milliseconds = 0; const probe = passProbe();
    const readiness = service(probe, wiring(), 2_000, 0, () => new Date(milliseconds++));
    await readiness.check(); await readiness.check();
    expect(probe.run).toHaveBeenCalledTimes(2);
  });

  it("R-11 does not serve a stale success when a fresh probe fails", async () => {
    let milliseconds = 0;
    const probe = { run: vi.fn().mockResolvedValueOnce({ database: "PASS", schema: "PASS" })
      .mockResolvedValueOnce({ database: "FAIL", schema: "SKIPPED" }) };
    const readiness = service(probe, wiring(), 2_000, 1_000, () => new Date(milliseconds));
    expect((await readiness.check()).ready).toBe(true); milliseconds = 1_001;
    expect((await readiness.check()).ready).toBe(false);
  });

  it("R-12 treats disabled optional workers as healthy without warnings", async () => {
    expect(await service().check()).toMatchObject({ ready: true, warnings: [] });
  });

  it("R-13 reports inactive enabled Telegram polling as a non-gating warning", async () => {
    const result = await service(passProbe(), wiring({ telegramPolling: { enabled: true, active: () => false } })).check();
    expect(result).toMatchObject({ ready: true, warnings: ["TELEGRAM_POLLING_INACTIVE"] });
  });

  it("R-14 reports inactive enabled scheduler and evaluator without failing readiness", async () => {
    const result = await service(passProbe(), wiring({ reminderScheduler: { enabled: true, active: () => false },
      alertEvaluator: { enabled: true, active: () => false } })).check();
    expect(result).toMatchObject({ ready: true,
      warnings: ["REMINDER_SCHEDULER_INACTIVE", "ALERT_EVALUATOR_INACTIVE"] });
  });

  it("R-15 emits no warning for active optional workers", async () => {
    const active = { enabled: true, active: () => true };
    expect((await service(passProbe(), wiring({ telegramPolling: active, reminderScheduler: active,
      alertEvaluator: active })).check()).warnings).toEqual([]);
  });

  it("R-16 converts an unexpected handler failure to a sanitized 503", async () => {
    const app = await appFor({ check: vi.fn().mockRejectedValue(new Error("secret host table migration")) });
    const response = await app.inject("/ready");
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toMatch(/secret|host|table|migration/i);
    await app.close();
  });

  it("R-17 exposes only approved payload fields and warning values", async () => {
    const result = await service(passProbe(), wiring({ telegramPolling: { enabled: true, active: () => false } })).check();
    expect(Object.keys(result).sort()).toEqual(["checks", "observed_at", "ready", "status", "warnings"]);
    expect(Object.keys(result.checks).sort()).toEqual(["core_routes", "database", "schema"]);
    expect(JSON.stringify(result)).not.toMatch(/READINESS_RESULT_STALE|environment|migration|table|host/i);
  });

  it("R-18 marks both health endpoints rate-limit exempt and readiness no-store", async () => {
    const policies = new Map<string, unknown>();
    const app = Fastify({ logger: false });
    app.addHook("onRoute", (route) => { policies.set(String(route.url), route.config?.rateLimit); });
    await app.register(healthRoutes, { readiness: service() });
    const response = await app.inject("/ready");
    expect(policies.get("/health")).toBe("exempt");
    expect(policies.get("/ready")).toBe("exempt");
    expect(response.headers["cache-control"]).toBe("no-store");
    await app.close();
  });

  it("uses exactly one abortable read-only polling-state RPC for the combined database/schema probe", async () => {
    const abortSignal = vi.fn().mockResolvedValue({ data: 0, error: null });
    const rpc = vi.fn().mockReturnValue({ abortSignal });
    await expect(new SupabaseReadinessProbe({ rpc } as never).run(new AbortController().signal))
      .resolves.toEqual({ database: "PASS", schema: "PASS" });
    expect(rpc).toHaveBeenCalledWith("load_telegram_polling_state");
    expect(abortSignal).toHaveBeenCalledOnce();
  });

  it("treats a missing polling-state singleton as an incomplete schema contract", async () => {
    const abortSignal = vi.fn().mockResolvedValue({ data: null, error: null });
    await expect(new SupabaseReadinessProbe({ rpc: vi.fn().mockReturnValue({ abortSignal }) } as never)
      .run(new AbortController().signal)).resolves.toEqual({ database: "PASS", schema: "FAIL" });
  });
});
