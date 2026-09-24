import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient, createManualTask, csrfTokenFromCookie, loadResources, loginErrorMessage, taskSummary } from "../../public/ui-core.js";

const asset = (name) => readFile(path.resolve("public", name), "utf8");
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});

describe("Sotoayam runnable dashboard demo", () => {
  it("offers a SYSTEM_ADMIN-only test notification form through the session and CSRF client", async () => {
    const html = await asset("index.html");
    const app = await asset("app.js");
    expect(html).toContain('id="test-notification-card"');
    expect(html).toContain('id="test-notification-type"');
    expect(html).toContain('id="test-notification-recipient"');
    expect(app).toContain('/api/admin/notifications/test-recipients?type=');
    expect(app).toContain('/api/admin/notifications/test');
    expect(app).toContain('window.confirm(uiMessages.testNotification.confirm)');
    const fetch = vi.fn().mockResolvedValue(json({ success: true, data: { sent: 1, failed: 0 } }));
    const api = createApiClient({ fetchImpl: fetch, cookie: () => "sotoayam_csrf=csrf-test-value" });
    await api("/api/admin/notifications/test", { method: "POST", body: JSON.stringify({
      recipient_user_id: 7, request_id: "00000000-0000-4000-8000-000000000001", type: "SYSTEM_ERROR" }) });
    expect(fetch).toHaveBeenCalledWith("/api/admin/notifications/test", expect.objectContaining({
      credentials: "same-origin", headers: expect.objectContaining({ "X-CSRF-Token": "csrf-test-value" }) }));
  });
  it("creates a task through the existing session/CSRF API once and keeps server actor ownership", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ success: true, data: { id: 41, title: "Periksa stok" } }, 201));
    const api = createApiClient({ fetchImpl: fetch, cookie: () => "sotoayam_csrf=csrf-test-value" });
    const response = await createManualTask(api, { title: " Periksa stok ", description: " Perlu dicek ",
      priority: "NORMAL", deadline: "" });
    expect(response.data.id).toBe(41);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/tasks", expect.objectContaining({ method: "POST", credentials: "same-origin",
      headers: expect.objectContaining({ "X-CSRF-Token": "csrf-test-value" }),
      body: JSON.stringify({ title: "Periksa stok", description: "Perlu dicek", priority: "NORMAL" }) }));
    const html = await asset("index.html"); const app = await asset("app.js");
    expect(html).toContain('id="create-task-form"');
    expect(html.match(/data-create-task/g)).toHaveLength(2);
    expect(app).toContain("await loadTasks()");
  });

  it("shows a local error for malformed optional deadline without issuing a request", async () => {
    const api = vi.fn();
    await expect(createManualTask(api, { title: "Task", description: "", priority: "NORMAL",
      deadline: "not-a-date" })).rejects.toThrow("Tenggat tugas tidak valid.");
    expect(api).not.toHaveBeenCalled();
  });

  it("surfaces task-create authorization failure without retrying or exposing a shared key", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ success: false,
      error: { code: "TASK_FORBIDDEN", message: "Task creation is forbidden" } }, 403));
    const api = createApiClient({ fetchImpl: fetch, cookie: () => "sotoayam_csrf=csrf-test-value" });
    await expect(createManualTask(api, { title: "Test", description: "", priority: "NORMAL", deadline: "" }))
      .rejects.toMatchObject({ status: 403, code: "TASK_FORBIDDEN" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
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

  it("uses the current session's CSRF cookie when old secure and new local cookies coexist", async () => {
    const cookies = "__Host-sotoayam_csrf=old-token; sotoayam_csrf=current-token";
    expect(csrfTokenFromCookie(cookies)).toBe("old-token");
    expect(csrfTokenFromCookie(cookies, "sotoayam_csrf")).toBe("current-token");
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    let session = { csrf_cookie_name: "sotoayam_csrf" };
    const api = createApiClient({ fetchImpl: fetch, cookie: () => cookies,
      csrfCookieName: () => session.csrf_cookie_name });
    await api("/api/admin/auth/logout", { method: "POST" });
    expect(fetch.mock.calls[0]?.[1]?.headers["X-CSRF-Token"]).toBe("current-token");
    session = { csrf_cookie_name: "__Host-sotoayam_csrf" };
    await api("/api/tasks", { method: "POST", body: "{}" });
    expect(fetch.mock.calls[1]?.[1]?.headers["X-CSRF-Token"]).toBe("old-token");
  });

  it("keeps the selected CSRF cookie through login and authenticated session refresh", async () => {
    let principal = null;
    const cookies = "__Host-sotoayam_csrf=previous-session; sotoayam_csrf=current-session";
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ success: true, data: { csrf_cookie_name: "sotoayam_csrf" } }))
      .mockResolvedValueOnce(json({ success: true, data: { csrf_cookie_name: "sotoayam_csrf" } }))
      .mockResolvedValue(new Response(null, { status: 204 }));
    const api = createApiClient({ fetchImpl: fetch, cookie: () => cookies,
      csrfCookieName: () => principal?.csrf_cookie_name });
    principal = (await api("/api/admin/auth/login", { method: "POST", body: "{}" })).data;
    principal = (await api("/api/admin/auth/session")).data;
    await api("/api/tasks", { method: "POST", body: "{}" });
    await api("/api/admin/auth/logout", { method: "POST" });
    expect(fetch.mock.calls[2]?.[1]?.headers["X-CSRF-Token"]).toBe("current-session");
    expect(fetch.mock.calls[3]?.[1]?.headers["X-CSRF-Token"]).toBe("current-session");
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

  it("accepts a real NOT_READY payload for the System view without treating it as a session failure", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ ready: false, status: "NOT_READY",
      checks: { database: "FAIL", schema: "SKIPPED", core_routes: "PASS" }, warnings: [],
      observed_at: "2026-09-12T00:00:00.000Z" }, 503));
    const api = createApiClient({ fetchImpl: fetch });
    await expect(api("/ready", { acceptStatuses: [503] })).resolves.toMatchObject({ status: "NOT_READY" });
  });

  it("contains all required navigation and neutral unavailable states", async () => {
    const html = await asset("index.html");
    for (const label of ["Dashboard", "Tugas", "Integrasi", "Notifikasi / Aktivitas", "Sistem"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('id="readiness-card"');
    expect(html).toContain('id="runtime-settings-card"');
    expect(html).toContain("Penanggung jawab bisnis");
    expect(html).not.toContain("dijadwalkan pada P1-07");
    expect(html).toContain('id="login-form"');
    expect(html).toContain('id="logout"');
  });

  it("does not expose or persist shared keys, credentials, or service secrets in browser assets", async () => {
    const browser = [await asset("index.html"), await asset("app.js"), await asset("ui-core.js"), await asset("settings.js")].join("\n");
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
