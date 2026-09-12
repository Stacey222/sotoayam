export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function csrfTokenFromCookie(cookieValue) {
  const pairs = String(cookieValue || "").split(";").map((item) => item.trim()).filter(Boolean);
  for (const pair of pairs) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    try {
      const name = decodeURIComponent(pair.slice(0, separator));
      if (name === "__Host-sotoayam_csrf" || name === "sotoayam_csrf") {
        return decodeURIComponent(pair.slice(separator + 1));
      }
    } catch { /* Ignore an unrelated malformed cookie rather than breaking session actions. */ }
  }
  return "";
}

export function createApiClient({ fetchImpl = globalThis.fetch, cookie = () => globalThis.document?.cookie ?? "",
  onUnauthorized = () => undefined } = {}) {
  return async function api(path, options = {}) {
    const { handleUnauthorized = true, ...requestOptions } = options;
    const method = String(requestOptions.method || "GET").toUpperCase();
    const headers = { Accept: "application/json", ...(requestOptions.body ? { "Content-Type": "application/json" } : {}),
      ...(requestOptions.headers || {}) };
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      const csrf = csrfTokenFromCookie(cookie());
      if (csrf) headers["X-CSRF-Token"] = csrf;
    }
    let response;
    try {
      response = await fetchImpl(path, { ...requestOptions, method, headers, credentials: "same-origin" });
    } catch {
      throw new ApiError(0, "NETWORK_ERROR", "Tidak dapat terhubung ke Sotoayam.");
    }
    const payload = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      const error = new ApiError(response.status, payload?.error?.code || "REQUEST_FAILED",
        payload?.error?.message || "Permintaan tidak dapat diproses.");
      if (response.status === 401 && handleUnauthorized) onUnauthorized(error);
      throw error;
    }
    return payload;
  };
}

export async function loadResources(api, resources) {
  const entries = await Promise.all(resources.map(async ({ key, path }) => {
    try {
      const payload = await api(path);
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

export function loginErrorMessage(error) {
  if (error?.code === "INVALID_CREDENTIALS") return "Email atau kata sandi tidak valid.";
  if (error?.code === "LOGIN_THROTTLED" || error?.code === "RATE_LIMITED") {
    return "Terlalu banyak percobaan. Tunggu beberapa saat lalu coba lagi.";
  }
  if (error?.status === 0) return "Sotoayam tidak dapat dijangkau. Periksa layanan lokal Anda.";
  return error?.message || "Login tidak dapat diproses.";
}
