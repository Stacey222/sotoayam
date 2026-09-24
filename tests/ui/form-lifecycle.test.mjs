import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { allowedTaskStatusTransitions, bindResettableDialog, cancelTask, createApiClient, createManualTask, setDialogBusy, transitionTask, updateTask } from "../../public/ui-core.js";
import { changeUserActive, createAdministrator } from "../../public/users.js";

function dialogHarness() {
  const listeners = new Map();
  const buttons = [0, 1].map(() => ({
    type: "button", click: () => undefined,
    addEventListener(name, listener) { this[name] = listener; },
  }));
  const form = { value: "", reset: vi.fn(() => { form.value = ""; }) };
  const error = { hidden: false, textContent: "Failed" };
  const dialog = {
    open: false,
    querySelectorAll: () => buttons,
    addEventListener: (name, listener) => listeners.set(name, listener),
    showModal() { this.open = true; },
    close() { this.open = false; listeners.get("close")(); },
  };
  bindResettableDialog(dialog, form, error);
  return { dialog, form, error, buttons, listeners };
}

const response = (data, status = 200) => new Response(JSON.stringify({ success: true, data }), {
  status, headers: { "content-type": "application/json" },
});

describe("dashboard form lifecycle", () => {
  it("renders cancel and X controls as non-submit buttons on both required create forms and task edit", async () => {
    const html = await readFile(new URL("../../public/index.html", import.meta.url), "utf8");
    for (const name of ["create-task", "create-user", "edit-task", "status-task", "cancel-task"]) {
      const markup = html.match(new RegExp(`<dialog id="${name}-dialog"[\\s\\S]*?</dialog>`))?.[0];
      expect(markup).toBeTruthy();
      expect(markup).toMatch(/<button[^>]*type="button"[^>]*data-dialog-cancel[^>]*aria-label="Tutup"/);
      expect(markup).toMatch(/<button[^>]*type="button"[^>]*data-dialog-cancel>Batal<\/button>/);
      expect(markup).toMatch(/<button[^>]*type="submit"/);
      expect(markup).not.toContain('method="dialog"');
    }
  });

  for (const name of ["Create Task", "Create Administrator", "Edit Task", "Change Task Status", "Cancel Task"]) {
    it(`${name}: empty and partial cancellation closes, resets, and reopens cleanly`, () => {
      const { dialog, form, error, buttons } = dialogHarness();
      dialog.showModal(); buttons[0].click();
      expect(dialog.open).toBe(false);
      dialog.showModal(); form.value = "partial"; buttons[1].click();
      expect(dialog.open).toBe(false);
      expect(form.value).toBe("");
      expect(error).toEqual({ hidden: true, textContent: "" });
      dialog.showModal(); expect(form.value).toBe("");
      expect(form.reset).toHaveBeenCalledTimes(2);
    });
  }

  it("Escape/close resets unsaved state without a mutation", () => {
    const { dialog, form } = dialogHarness();
    dialog.showModal(); form.value = "partial"; dialog.close();
    expect(form.value).toBe("");
  });

  it("keeps cancel usable until a mutation begins, then blocks Escape until it settles", () => {
    const { dialog, buttons, listeners } = dialogHarness();
    const first = { preventDefault: vi.fn() };
    listeners.get("cancel")(first);
    expect(first.preventDefault).not.toHaveBeenCalled();
    setDialogBusy(dialog, true);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    const pending = { preventDefault: vi.fn() };
    listeners.get("cancel")(pending);
    expect(pending.preventDefault).toHaveBeenCalledOnce();
    setDialogBusy(dialog, false);
    expect(buttons.every((button) => !button.disabled)).toBe(true);
  });

  it("task create, update and lifecycle cancellation use one existing request each", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ id: 3 }, 201))
      .mockResolvedValueOnce(response({ id: 3 })).mockResolvedValueOnce(response({ id: 3, status: "CANCELLED" }));
    const api = createApiClient({ fetchImpl: fetch, cookie: () => "sotoayam_csrf=current" });
    await createManualTask(api, { title: " Tugas ", description: "", priority: "NORMAL", deadline: "", assignedToUserId: 7 });
    await updateTask(api, 3, { title: " Baru ", description: "", priority: "HIGH", deadline: "" });
    await cancelTask(api, 3);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[0][1].body).toContain('"assigned_to":7');
    expect(fetch.mock.calls[1][0]).toBe("/api/tasks/3");
    expect(fetch.mock.calls[1][1].method).toBe("PATCH");
    expect(fetch.mock.calls[2][0]).toBe("/api/tasks/3/status");
    expect(fetch.mock.calls[2][1].body).toBe('{"status":"CANCELLED"}');
    for (const [, options] of fetch.mock.calls) expect(options.headers["X-CSRF-Token"]).toBe("current");
  });

  it("cancellation reason is sent through the existing status transition once", async () => {
    const api = vi.fn().mockResolvedValue({ data: { status: "CANCELLED" } });
    await cancelTask(api, 3, " Administrative cleanup ");
    expect(api).toHaveBeenCalledOnce();
    expect(JSON.parse(api.mock.calls[0][1].body)).toEqual({ status: "CANCELLED", note: "Administrative cleanup" });
  });

  it("offers only valid non-cancellation lifecycle transitions", () => {
    expect(allowedTaskStatusTransitions("OPEN")).toEqual(["IN_PROGRESS", "BLOCKED", "COMPLETED"]);
    expect(allowedTaskStatusTransitions("BLOCKED")).toEqual(["IN_PROGRESS", "COMPLETED"]);
    expect(allowedTaskStatusTransitions("COMPLETED")).toEqual([]);
  });

  it("moves a task to IN_PROGRESS through one existing status request", async () => {
    const api = vi.fn().mockResolvedValue({ data: { id: 3, status: "IN_PROGRESS" } });
    await transitionTask(api, 3, "IN_PROGRESS");
    expect(api).toHaveBeenCalledOnce();
    expect(api).toHaveBeenCalledWith("/api/tasks/3/status", {
      method: "POST", body: '{"status":"IN_PROGRESS"}',
    });
  });

  it("invalid task deadline rejects before any request", async () => {
    const api = vi.fn();
    await expect(updateTask(api, 3, { title: "Tugas", description: "", priority: "NORMAL", deadline: "invalid" }))
      .rejects.toThrow();
    expect(api).not.toHaveBeenCalled();
  });

  it("creates an administrator through one authenticated request and keeps the temporary password in response only", async () => {
    const fetch = vi.fn().mockResolvedValue(response({ temporary_password: "returned-once" }, 201));
    const api = createApiClient({ fetchImpl: fetch, cookie: () => "sotoayam_csrf=current" });
    const result = await createAdministrator(api, { display_name: "Admin", email: "admin@example.test",
      division_id: "2", role_id: "3", grant_system_admin: false, reason: "Operational account" });
    expect(result.data.temporary_password).toBe("returned-once");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("/api/admin/users");
    expect(fetch.mock.calls[0][1].headers["X-CSRF-Token"]).toBe("current");
    expect(fetch.mock.calls[0][1].body).not.toContain("temporary_password");
  });

  it("deactivates/reactivates via audited access changes without deleting a user", async () => {
    const fetch = vi.fn().mockResolvedValue(response({ id: 9 }));
    const api = createApiClient({ fetchImpl: fetch, cookie: () => "sotoayam_csrf=current" });
    const user = { id: 9, division: { id: 2 }, role: { id: 3 } };
    await changeUserActive(api, user, false);
    await changeUserActive(api, user, true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([url, options]) => [url, options.method])).toEqual([
      ["/api/admin/users/9/access", "PATCH"], ["/api/admin/users/9/access", "PATCH"],
    ]);
    expect(JSON.parse(fetch.mock.calls[0][1].body).active).toBe(false);
    expect(JSON.parse(fetch.mock.calls[1][1].body).active).toBe(true);
  });
});
