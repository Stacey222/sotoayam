import { uiMessages } from "./messages.js";

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function csrfTokenFromCookie(cookieValue, expectedName) {
  const pairs = String(cookieValue || "").split(";").map((item) => item.trim()).filter(Boolean);
  for (const pair of pairs) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    try {
      const name = decodeURIComponent(pair.slice(0, separator));
      if (name === expectedName || (!expectedName && (name === "__Host-sotoayam_csrf" || name === "sotoayam_csrf"))) {
        return decodeURIComponent(pair.slice(separator + 1));
      }
    } catch { /* Ignore an unrelated malformed cookie rather than breaking session actions. */ }
  }
  return "";
}

const busyDialogs = new WeakSet();

export function bindResettableDialog(dialog, form, error) {
  dialog.querySelectorAll("[data-dialog-cancel]").forEach((button) => {
    button.addEventListener("click", () => dialog.close());
  });
  dialog.addEventListener("close", () => {
    form.reset();
    error.textContent = "";
    error.hidden = true;
  });
  dialog.addEventListener("cancel", (event) => { if (busyDialogs.has(dialog)) event.preventDefault(); });
}

export function setDialogBusy(dialog, busy) {
  if (busy) busyDialogs.add(dialog);
  else busyDialogs.delete(dialog);
  dialog.querySelectorAll("[data-dialog-cancel]").forEach((button) => { button.disabled = busy; });
}

export function createApiClient({ fetchImpl = globalThis.fetch, cookie = () => globalThis.document?.cookie ?? "",
  csrfCookieName = () => undefined, onUnauthorized = () => undefined } = {}) {
  return async function api(path, options = {}) {
    const { handleUnauthorized = true, acceptStatuses = [], ...requestOptions } = options;
    const method = String(requestOptions.method || "GET").toUpperCase();
    const headers = { Accept: "application/json", ...(requestOptions.body ? { "Content-Type": "application/json" } : {}),
      ...(requestOptions.headers || {}) };
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      const csrf = csrfTokenFromCookie(cookie(), csrfCookieName());
      if (csrf) headers["X-CSRF-Token"] = csrf;
    }
    let response;
    try {
      response = await fetchImpl(path, { ...requestOptions, method, headers, credentials: "same-origin" });
    } catch {
      throw new ApiError(0, "NETWORK_ERROR", uiMessages.api.network);
    }
    const payload = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok && !acceptStatuses.includes(response.status)) {
      const error = new ApiError(response.status, payload?.error?.code || "REQUEST_FAILED",
        payload?.error?.message || uiMessages.api.requestFailed);
      if (response.status === 401 && handleUnauthorized) onUnauthorized(error);
      throw error;
    }
    return payload;
  };
}

export async function loadResources(api, resources) {
  const entries = await Promise.all(resources.map(async ({ key, path, options }) => {
    try {
      const payload = await api(path, options);
      return [key, { available: true, data: payload?.data ?? payload }];
    } catch (error) {
      return [key, { available: false, error }];
    }
  }));
  return Object.fromEntries(entries);
}

export function taskSummary(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  return {
    total: list.length,
    active: list.filter((task) => ["OPEN", "IN_PROGRESS", "BLOCKED"].includes(task.status)).length,
    overdue: list.filter((task) => task.is_overdue === true).length,
    completed: list.filter((task) => task.status === "COMPLETED").length,
  };
}

export async function createManualTask(api, values) {
  const deadline = values.deadline ? new Date(values.deadline) : null;
  if (deadline && !Number.isFinite(deadline.getTime())) throw new Error(uiMessages.tasks.invalidDeadline);
  return api("/api/tasks", { method: "POST", body: JSON.stringify({
    title: values.title.trim(),
    ...(values.description.trim() ? { description: values.description.trim() } : {}),
    priority: values.priority,
    ...(values.assignedToUserId ? { assigned_to: values.assignedToUserId } : {}),
    ...(deadline ? { deadline: deadline.toISOString() } : {}),
  }) });
}

export async function updateTask(api, id, values) {
  const deadline = values.deadline ? new Date(values.deadline) : null;
  if (deadline && !Number.isFinite(deadline.getTime())) throw new Error(uiMessages.tasks.invalidDeadline);
  return api(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify({
    title: values.title.trim(), description: values.description.trim() || null,
    priority: values.priority, deadline: deadline ? deadline.toISOString() : null,
  }) });
}

const taskStatusTransitions = Object.freeze({
  DRAFT: Object.freeze(["OPEN"]),
  OPEN: Object.freeze(["IN_PROGRESS", "BLOCKED", "COMPLETED"]),
  IN_PROGRESS: Object.freeze(["BLOCKED", "COMPLETED"]),
  BLOCKED: Object.freeze(["IN_PROGRESS", "COMPLETED"]),
  COMPLETED: Object.freeze([]),
  CANCELLED: Object.freeze([]),
});

export function allowedTaskStatusTransitions(status) {
  return taskStatusTransitions[status] || [];
}

export function transitionTask(api, id, status, note = "") {
  return api(`/api/tasks/${id}/status`, { method: "POST", body: JSON.stringify({
    status, ...(note.trim() ? { note: note.trim() } : {}),
  }) });
}

export function cancelTask(api, id, note = "") {
  return transitionTask(api, id, "CANCELLED", note);
}

export function loginErrorMessage(error) {
  if (error?.code === "INVALID_CREDENTIALS") return uiMessages.auth.invalidCredentials;
  if (error?.code === "LOGIN_THROTTLED" || error?.code === "RATE_LIMITED") {
    return uiMessages.auth.throttled;
  }
  if (error?.status === 0) return uiMessages.auth.unreachable;
  return error?.message || uiMessages.auth.loginFailed;
}
