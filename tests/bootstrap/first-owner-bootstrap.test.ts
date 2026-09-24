import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { FirstAdminBootstrapInput, FirstAdminBootstrapRepository } from "../../src/repositories/first-admin-bootstrap.repository.js";
import { FirstAdminBootstrapError } from "../../src/repositories/first-admin-bootstrap.repository.js";
import { SupabaseFirstAdminBootstrapRepository } from "../../src/repositories/first-admin-bootstrap.repository.js";
import { setupRoutes } from "../../src/routes/setup.routes.js";
import { FirstOwnerBootstrapService } from "../../src/services/first-owner-bootstrap.service.js";

class OwnerRepository implements FirstAdminBootstrapRepository {
  eligible = true;
  provisioned?: FirstAdminBootstrapInput & { divisionCode: string; divisionName: string; businessTimeZone: string };
  async getStatus() { return { eligible: this.eligible }; }
  async bootstrap(): Promise<never> { throw new Error("not used"); }
  async provisionOwner(input: FirstAdminBootstrapInput & { divisionCode: string; divisionName: string;
    businessTimeZone: string; reminderSchedulerIntervalSeconds: number; criticalAlertPolicy: unknown }) {
    if (!this.eligible) throw new FirstAdminBootstrapError("FIRST_ADMIN_ALREADY_EXISTS", "Setup is complete");
    this.provisioned = input;
    this.eligible = false;
    return { userId: 9, assignmentId: 11, bootstrappedAt: new Date(0).toISOString(),
      divisionCode: input.divisionCode, settingsVersion: 2 };
  }
}

const defaults = { reminderSchedulerIntervalSeconds: 300,
  criticalAlertPolicy: { overdue: { warningHours: 1, highHours: 24, criticalHours: 72 },
    blocked: { warningHours: 4, highHours: 24, criticalHours: 72 },
    scheduler: { staleMinutes: 15, criticalMinutes: 60 } } };

async function app(repository = new OwnerRepository()) {
  const instance = Fastify();
  await instance.register(fastifyCookie);
  await instance.register(setupRoutes, { prefix: "/api/setup",
    service: new FirstOwnerBootstrapService(repository, defaults), cookieSecure: false,
    defaultBusinessTimeZone: "Asia/Jakarta" });
  return { instance, repository };
}

function cookieValue(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0]! : header!;
  return /sotoayam_setup_csrf=([^;]+)/.exec(value)?.[1] ?? "";
}

describe("P3-01 first-owner setup HTTP contract", () => {
  it("reports setup without exposing existing identities and issues a sessionless CSRF token", async () => {
    const { instance } = await app();
    const response = await instance.inject({ method: "GET", url: "/api/setup/status" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true, data: { required: true,
      default_business_time_zone: "Asia/Jakarta", password_min_length: 12,
      csrf_cookie_name: "sotoayam_setup_csrf" } });
    expect(cookieValue(response.headers["set-cookie"])).toHaveLength(43);
    expect(response.body).not.toMatch(/user_id|email|completed_at/);
    await instance.close();
  });

  it("creates an OWNER with explicit authority using only the current CSRF token", async () => {
    const { instance, repository } = await app();
    const status = await instance.inject({ method: "GET", url: "/api/setup/status" });
    const csrf = cookieValue(status.headers["set-cookie"]);
    const response = await instance.inject({ method: "POST", url: "/api/setup",
      headers: { cookie: `sotoayam_setup_csrf=${csrf}`, "x-csrf-token": csrf },
      payload: { display_name: "  Owner Baru  ", email: " Owner@Example.COM ",
        password: "orchid-river-canvas-ember-91", password_confirmation: "orchid-river-canvas-ember-91",
        division_name: "Operasional Utama", business_time_zone: "Asia/Jakarta" } });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ success: true, data: { user_id: 9, role: "OWNER",
      authority: "SYSTEM_ADMIN", password_change_required: false } });
    expect(repository.provisioned).toMatchObject({ displayName: "Owner Baru", email: "owner@example.com",
      divisionCode: "OPERASIONAL_UTAMA", businessTimeZone: "Asia/Jakarta", passwordAlgorithm: "scrypt" });
    expect(repository.provisioned).not.toHaveProperty("password");
    await instance.close();
  });

  it("rejects missing/stale CSRF and rejects replay after completion", async () => {
    const { instance } = await app();
    const payload = { display_name: "Owner Baru", email: "owner@example.com",
      password: "orchid-river-canvas-ember-91", password_confirmation: "orchid-river-canvas-ember-91",
      division_name: "Operations", business_time_zone: "UTC" };
    expect((await instance.inject({ method: "POST", url: "/api/setup", payload })).statusCode).toBe(403);
    const status = await instance.inject({ method: "GET", url: "/api/setup/status" });
    const csrf = cookieValue(status.headers["set-cookie"]);
    expect((await instance.inject({ method: "POST", url: "/api/setup",
      headers: { cookie: `sotoayam_setup_csrf=${csrf}`, "x-csrf-token": "stale-token" }, payload })).statusCode).toBe(403);
    expect((await instance.inject({ method: "POST", url: "/api/setup",
      headers: { cookie: `sotoayam_setup_csrf=${csrf}`, "x-csrf-token": csrf }, payload })).statusCode).toBe(201);
    const replayStatus = await instance.inject({ method: "GET", url: "/api/setup/status" });
    expect(replayStatus.json().data.required).toBe(false);
    expect(replayStatus.headers["set-cookie"]).toBeUndefined();
    expect((await instance.inject({ method: "POST", url: "/api/setup",
      headers: { cookie: `sotoayam_setup_csrf=${csrf}`, "x-csrf-token": csrf }, payload })).statusCode).toBe(409);
    await instance.close();
  });

  it("does not log or return passwords", async () => {
    const repository = new OwnerRepository();
    const spy = vi.spyOn(repository, "provisionOwner");
    const service = new FirstOwnerBootstrapService(repository, defaults);
    const result = await service.provision({ displayName: "Owner", email: "owner@example.com",
      password: "orchid-river-canvas-ember-91", divisionCode: "OPS", divisionName: "Ops", businessTimeZone: "UTC" });
    expect(result).not.toHaveProperty("password");
    expect(JSON.stringify(result)).not.toContain("orchid-river-canvas-ember-91");
    expect(spy.mock.calls[0]?.[0]).not.toHaveProperty("password");
  });

  it("sends only a password hash and bounded settings to the atomic RPC", async () => {
    const single = vi.fn().mockResolvedValue({ data: { user_id: 9, assignment_id: 11,
      bootstrapped_at: new Date(0).toISOString(), division_code: "OPS", settings_version: 2 }, error: null });
    const rpc = vi.fn().mockReturnValue({ single });
    const repository = new SupabaseFirstAdminBootstrapRepository({ rpc } as unknown as SupabaseClient);
    await repository.provisionOwner!({ displayName: "Owner", email: "owner@example.com",
      passwordAlgorithm: "scrypt", passwordHash: "encoded-secret", divisionCode: "OPS", divisionName: "Ops",
      businessTimeZone: "UTC", reminderSchedulerIntervalSeconds: 300, criticalAlertPolicy: defaults.criticalAlertPolicy });
    expect(rpc).toHaveBeenCalledWith("provision_first_owner", expect.objectContaining({
      p_email: "owner@example.com", p_password_hash: "encoded-secret", p_business_time_zone: "UTC",
    }));
    expect(rpc.mock.calls[0]?.[1]).not.toHaveProperty("p_password");
  });

  it("ships generic local setup UI with no development identity or browser secret", async () => {
    const [html, script, appScript] = await Promise.all([
      readFile(path.resolve("public/setup.html"), "utf8"),
      readFile(path.resolve("public/setup.js"), "utf8"),
      readFile(path.resolve("public/app.js"), "utf8"),
    ]);
    expect(html).toContain("Buat pemilik pertama");
    expect(html).toContain('/vendor/tabler/tabler.min.css');
    expect(appScript).toContain('location.replace("/setup")');
    expect(`${html}\n${script}`).not.toMatch(/Kento|owner@sotoayam\.local|ADMIN_API_KEY|INTERNAL_API_KEY|SUPABASE_SERVICE/);
    expect(html).not.toMatch(/https?:\/\/(?:cdn|unpkg|jsdelivr)/i);
  });
});
