import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient, loadResources, loginErrorMessage, taskSummary } from "../../public/ui-core.js";

const asset = (name) => readFile(path.resolve("public", name), "utf8");
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});

describe("Sotoayam runnable dashboard demo", () => {
  it("provides the real login to dashboard smoke flow", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ success: true, data: { user_id: 7, email: "admin@example.test", display_name: "Admin" } }))
      .mockResolvedValueOnce(json({ success: true, data: [{ id: 1, status: "OPEN", is_overdue: false }] }));
    const api = createApiClient({ fetchImpl: fetch, cookie: () => "" });

    const login = await api("/api/admin/auth/login", { method: "POST", handleUnauthorized: false,
      body: JSON.stringify({ email: "admin@example.test", password: "test-password" }) });
    const dashboard = await loadResources(api, [{ key: "tasks", path: "/api/tasks" }]);

    expect(login.data.display_name).toBe("Admin");
    expect(dashboard.tasks).toMatchObject({ available: true, data: [{ id: 1 }] });
    expect(fetch.mock.calls.every(([, options]) => options.credentials === "same-origin")).toBe(true);
  });

  it("routes unauthenticated and expired-session responses to login handling", async () => {
    const onUnauthorized = vi.fn();
    const api = createApiClient({ fetchImpl: vi.fn().mockImplementation(async () => json({ success: false,
      error: { code: "SESSION_REQUIRED", message: "Session required" } }, 401)), onUnauthorized });

    await expect(api("/api/tasks")).rejects.toBeInstanceOf(ApiError);
    await expect(api("/api/admin/auth/session")).rejects.toMatchObject({ status: 401, code: "SESSION_REQUIRED" });
    expect(onUnauthorized).toHaveBeenCalledTimes(2);
  });

  it("logs out with the readable CSRF cookie and same-origin credentials", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const api = createApiClient({ fetchImpl: fetch, cookie: () => "sotoayam_csrf=csrf-demo-value" });

    await api("/api/admin/auth/logout", { method: "POST" });

    expect(fetch).toHaveBeenCalledWith("/api/admin/auth/logout", expect.objectContaining({ method: "POST",
      credentials: "same-origin", headers: expect.objectContaining({ "X-CSRF-Token": "csrf-demo-value" }) }));
  });

  it("keeps invalid-login and throttle messages useful without exposing backend detail", () => {
    expect(loginErrorMessage({ code: "INVALID_CREDENTIALS" })).toBe("Email atau kata sandi tidak valid.");
    expect(loginErrorMessage({ code: "LOGIN_THROTTLED" })).toContain("Terlalu banyak percobaan");
    expect(loginErrorMessage({ code: "RATE_LIMITED" })).toContain("Terlalu banyak percobaan");
  });

  it("settles dashboard API failures as unavailable without inventing metrics", async () => {
    const api = vi.fn(async (url) => {
      if (url === "/health") return { status: "ok" };
      throw new ApiError(503, "UNAVAILABLE", "Unavailable");
    });

    const result = await loadResources(api, [
      { key: "health", path: "/health" }, { key: "alerts", path: "/api/alerts" },
    ]);

    expect(result.health).toEqual({ available: true, data: { status: "ok" } });
    expect(result.alerts).toMatchObject({ available: false, error: { code: "UNAVAILABLE" } });
    expect(taskSummary(undefined)).toEqual({ total: 0, active: 0, overdue: 0, completed: 0 });
  });

  it("contains all required navigation and neutral unavailable states", async () => {
    const html = await asset("index.html");
    for (const label of ["Dashboard", "Tugas", "Integrasi", "Notifikasi / Aktivitas", "Sistem"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("Belum tersedia");
    expect(html).toContain('id="login-form"');
    expect(html).toContain('id="logout"');
  });

  it("does not expose or persist shared keys, credentials, or service secrets in browser assets", async () => {
    const browser = [await asset("index.html"), await asset("app.js"), await asset("ui-core.js")].join("\n");
    expect(browser).not.toMatch(/ADMIN_API_KEY|INTERNAL_API_KEY|SUPABASE_SERVICE|service_role|password_hash/i);
    expect(browser).not.toMatch(/localStorage|sessionStorage/);
    expect(browser).not.toMatch(/credential_hash|secret_hash/i);
    expect(browser).toContain("/api/admin/auth/login");
  });

  it("provides responsive mobile navigation and reduced-motion handling", async () => {
    const css = await asset("styles.css");
    expect(css).toMatch(/@media \(max-width: 991\.98px\)/);
    expect(css).toContain(".app-shell.nav-open .sidebar-nav");
    expect(css).toContain("prefers-reduced-motion: reduce");
    const html = await asset("index.html");
    expect(html).toContain('name="viewport"');
    expect(html).toContain('/vendor/tabler/tabler.min.css');
    expect(html).toContain('/vendor/tabler-icons/layout-dashboard.svg');
    expect(html).not.toMatch(/https?:\/\//);
  });
});
