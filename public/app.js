import { createApiClient, loadResources, loginErrorMessage, taskSummary } from "./ui-core.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = { authenticated: false, principal: null, tasks: [], integrations: [] };
const titles = { dashboard: "Dashboard", tasks: "Tugas", integrations: "Integrasi",
  notifications: "Notifikasi / Aktivitas", system: "Sistem" };

const api = createApiClient({ onUnauthorized: () => {
  if (state.authenticated) showLogin("Sesi Anda telah berakhir. Silakan masuk kembali.");
} });

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function badge(value) {
  const normalized = String(value || "UNKNOWN").toLowerCase();
  const labels = { in_progress: "Dikerjakan", open: "Terbuka", blocked: "Terhambat", completed: "Selesai",
    cancelled: "Dibatalkan", draft: "Draf", active: "Aktif", inactive: "Nonaktif", pending: "Tertunda",
    processing: "Diproses", delivered: "Terkirim", failed: "Gagal", unrouted: "Belum dirutekan",
    healthy: "Sehat", degraded: "Perlu perhatian", unhealthy: "Bermasalah", warning: "Peringatan",
    high: "Tinggi", critical: "Kritis", acknowledged: "Diakui", expired: "Kedaluwarsa", revoked: "Dicabut" };
  const tones = { open: "bg-blue-lt", in_progress: "bg-azure-lt", blocked: "bg-red-lt", completed: "bg-green-lt",
    cancelled: "bg-secondary-lt", draft: "bg-secondary-lt", active: "bg-green-lt", inactive: "bg-secondary-lt",
    pending: "bg-yellow-lt", processing: "bg-blue-lt", delivered: "bg-green-lt", failed: "bg-red-lt",
    unrouted: "bg-orange-lt", healthy: "bg-green-lt", degraded: "bg-yellow-lt", unhealthy: "bg-red-lt",
    warning: "bg-yellow-lt", high: "bg-orange-lt", critical: "bg-red-lt", acknowledged: "bg-blue-lt",
    expired: "bg-secondary-lt", revoked: "bg-red-lt" };
  return element("span", `badge ${tones[normalized] || "bg-secondary-lt"}`,
    labels[normalized] || String(value || "Belum tersedia"));
}

function formatDate(value, includeTime = false) {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat("id-ID", includeTime
    ? { dateStyle: "medium", timeStyle: "short" }
    : { day: "2-digit", month: "short", year: "numeric" }).format(new Date(value));
}

function unavailable(container, detail = "Data belum tersedia dari layanan saat ini.") {
  const box = element("div", "alert alert-secondary mb-0 unavailable");
  box.append(element("strong", "", "Belum tersedia"), element("span", "", detail));
  container.replaceChildren(box);
  container.classList.remove("loading");
}

function emptyState(container, detail) {
  const box = element("div", "empty py-4");
  box.append(element("p", "empty-title", "Belum ada data"), element("p", "empty-subtitle text-secondary", detail));
  container.replaceChildren(box);
  container.classList.remove("loading");
}

function setLoading(container, label) {
  container.className = "list-state loading";
  container.textContent = label;
  container.hidden = false;
}

function showLogin(message = "", info = false) {
  state.authenticated = false;
  state.principal = null;
  $("#app-shell").hidden = true;
  $("#login-view").hidden = false;
  const notice = $("#login-notice");
  notice.textContent = message;
  notice.classList.toggle("info", info);
  notice.hidden = !message;
  $("#login-password").value = "";
  $("#login-email").focus();
}

function enterApplication(principal) {
  state.authenticated = true;
  state.principal = principal;
  $("#login-view").hidden = true;
  $("#app-shell").hidden = false;
  $("#account-name").textContent = principal.display_name || "Administrator";
  $("#account-email").textContent = principal.email || "";
  $("#account-avatar").textContent = (principal.display_name || principal.email || "A").trim().charAt(0).toUpperCase();
  navigate(location.hash.slice(1) || "dashboard");
}

function showGlobal(message) {
  const notice = $("#global-notice");
  notice.textContent = message;
  notice.hidden = !message;
}

async function navigate(view) {
  const selected = titles[view] ? view : "dashboard";
  if (location.hash !== `#${selected}`) history.replaceState(null, "", `#${selected}`);
  $("#page-title").textContent = titles[selected];
  $$('[data-view-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.viewPanel !== selected;
    panel.classList.toggle("active", panel.dataset.viewPanel === selected);
  });
  $$('[data-view]').forEach((button) => button.classList.toggle("active", button.dataset.view === selected));
  $("#app-shell").classList.remove("nav-open");
  showGlobal("");
  if (selected === "dashboard") await loadDashboard();
  if (selected === "tasks") await loadTasks();
  if (selected === "integrations") await loadIntegrations();
  if (selected === "notifications") await loadNotifications();
  if (selected === "system") await loadSystem();
}

function renderDashboardTasks(tasks) {
  const container = $("#dashboard-tasks");
  const active = tasks.filter((task) => !["COMPLETED", "CANCELLED"].includes(task.status))
    .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at)).slice(0, 6);
  if (active.length === 0) return emptyState(container, "Tidak ada tugas aktif yang dapat ditampilkan.");
  const list = element("div", "task-list");
  for (const task of active) {
    const row = element("div", "task-row");
    const copy = element("div");
    copy.append(element("p", "item-title", task.title), element("p", "item-meta",
      `Tugas #${task.id} · Diperbarui ${formatDate(task.updated_at, true)}`));
    row.append(copy, badge(task.status), badge(task.priority));
    list.append(row);
  }
  container.className = "card-body";
  container.replaceChildren(list);
}

function renderDashboardAlerts(resource) {
  const container = $("#dashboard-alerts");
  if (!resource.available) return unavailable(container, "Endpoint peringatan belum dapat diakses oleh sesi ini.");
  const alerts = Array.isArray(resource.data) ? resource.data.slice(0, 5) : [];
  if (alerts.length === 0) return emptyState(container, "Tidak ada peringatan operasional aktif.");
  const list = element("div", "alert-list");
  for (const alert of alerts) {
    const row = element("div", "alert-row");
    const copy = element("div");
    copy.append(element("p", "item-title", alert.summary || alert.type),
      element("p", "item-meta", `${alert.affectedReference || "Operasional"} · ${formatDate(alert.lastDetectedAt, true)}`));
    row.append(badge(alert.severity), copy);
    list.append(row);
  }
  container.className = "card-body";
  container.replaceChildren(list);
}

async function loadDashboard() {
  setLoading($("#dashboard-tasks"), "Memuat tugas…");
  setLoading($("#dashboard-alerts"), "Memuat peringatan…");
  const resources = await loadResources(api, [
    { key: "tasks", path: "/api/tasks" },
    { key: "integrations", path: "/api/admin/integrations" },
    { key: "notifications", path: "/api/admin/notifications/status" },
    { key: "health", path: "/health" },
    { key: "alerts", path: "/api/alerts" },
    { key: "automation", path: "/api/alerts/automation-status" },
  ]);
  if (!state.authenticated) return;
  if (resources.tasks.available) {
    state.tasks = Array.isArray(resources.tasks.data) ? resources.tasks.data : [];
    const summary = taskSummary(state.tasks);
    $("#metric-task-total").textContent = String(summary.total);
    $("#metric-task-detail").textContent = `${summary.active} aktif · ${summary.overdue} terlambat · ${summary.completed} selesai`;
    renderDashboardTasks(state.tasks);
  } else {
    $("#metric-task-total").textContent = "—";
    $("#metric-task-detail").textContent = "Belum tersedia";
    unavailable($("#dashboard-tasks"));
  }
  if (resources.integrations.available) {
    state.integrations = Array.isArray(resources.integrations.data) ? resources.integrations.data : [];
    const active = state.integrations.filter((item) => item.active).length;
    $("#metric-integration-active").textContent = String(active);
    $("#metric-integration-detail").textContent = `${state.integrations.length} integrasi terdaftar`;
  } else {
    $("#metric-integration-active").textContent = "—";
    $("#metric-integration-detail").textContent = "Belum tersedia";
  }
  if (resources.notifications.available) {
    const data = resources.notifications.data;
    $("#metric-notification-pending").textContent = String(Number(data.pending || 0) + Number(data.processing || 0));
    $("#metric-notification-detail").textContent = `${Number(data.failed || 0)} gagal · ${Number(data.delivered || 0)} terkirim`;
  } else {
    $("#metric-notification-pending").textContent = "—";
    $("#metric-notification-detail").textContent = "Belum tersedia";
  }
  if (resources.health.available) {
    $("#metric-health").textContent = resources.health.data.status === "ok" ? "Sehat" : "Perlu perhatian";
    $("#metric-health-detail").textContent = resources.automation.available
      ? `Otomasi: ${resources.automation.data.overall || "belum tersedia"}` : "Runtime aktif · detail otomasi belum tersedia";
  } else {
    $("#metric-health").textContent = "—";
    $("#metric-health-detail").textContent = "Belum tersedia";
  }
  renderDashboardAlerts(resources.alerts);
}

function taskRow(task) {
  const row = document.createElement("tr");
  const title = element("td");
  title.append(element("span", "cell-title", task.title), element("span", "cell-subtitle",
    `#${task.id}${task.task_category ? ` · ${task.task_category}` : ""}`));
  const status = element("td"); status.append(badge(task.status));
  const priority = element("td"); priority.append(badge(task.priority));
  row.append(title, status, priority, element("td", "", `Divisi #${task.owner_division_id}`),
    element("td", "", task.deadline ? formatDate(task.deadline, true) : "Tanpa tenggat"));
  return row;
}

async function loadTasks() {
  const holder = $("#tasks-state");
  const body = $("#task-rows");
  body.replaceChildren(); setLoading(holder, "Memuat tugas…");
  const status = $("#task-status").value;
  try {
    const payload = await api(`/api/tasks${status ? `?status=${encodeURIComponent(status)}` : ""}`);
    state.tasks = Array.isArray(payload.data) ? payload.data : [];
    if (state.tasks.length === 0) return emptyState(holder, "Tidak ada tugas untuk filter ini.");
    body.replaceChildren(...state.tasks.map(taskRow));
    holder.hidden = true;
  } catch (error) {
    if (error.status !== 401) unavailable(holder, "Daftar tugas tidak dapat dimuat saat ini.");
  }
}

async function loadCredentials(integration) {
  const panel = $("#credential-panel");
  const list = $("#credential-list");
  panel.hidden = false;
  $("#credential-title").textContent = `Metadata kredensial · ${integration.name}`;
  setLoading(list, "Memuat metadata kredensial…");
  try {
    const payload = await api(`/api/admin/integrations/${integration.id}/credentials`);
    const credentials = Array.isArray(payload.data) ? payload.data : [];
    if (credentials.length === 0) return emptyState(list, "Belum ada metadata kredensial untuk integrasi ini.");
    const wrapper = element("div", "credential-list");
    for (const credential of credentials) {
      const row = element("div", "credential-row");
      const copy = element("div");
      copy.append(element("p", "item-title", credential.label), element("p", "item-meta",
        `Selector ${credential.selector} · Terakhir dipakai ${formatDate(credential.last_used_at, true)}`));
      row.append(copy, badge(credential.status)); wrapper.append(row);
    }
    list.className = "card-body"; list.replaceChildren(wrapper);
  } catch (error) {
    if (error.status !== 401) unavailable(list, "Metadata kredensial tidak dapat diakses.");
  }
}

async function loadIntegrations() {
  const holder = $("#integrations-state"); const body = $("#integration-rows");
  body.replaceChildren(); $("#credential-panel").hidden = true; setLoading(holder, "Memuat integrasi…");
  try {
    const payload = await api("/api/admin/integrations");
    state.integrations = Array.isArray(payload.data) ? payload.data : [];
    if (state.integrations.length === 0) return emptyState(holder, "Belum ada integrasi yang terdaftar.");
    for (const integration of state.integrations) {
      const row = document.createElement("tr");
      const name = element("td"); name.append(element("span", "cell-title", integration.name), element("span", "cell-subtitle", integration.code));
      const status = element("td"); status.append(badge(integration.active ? "ACTIVE" : "INACTIVE"));
      const action = element("td"); const button = element("button", "table-action", "Lihat metadata");
      button.type = "button"; button.dataset.integrationId = String(integration.id); action.append(button);
      row.append(name, element("td", "", integration.source), element("td", "", `Divisi #${integration.requesting_division_id}`), status, action);
      body.append(row);
    }
    holder.hidden = true;
  } catch (error) {
    if (error.status !== 401) unavailable(holder, "Daftar integrasi tidak dapat dimuat saat ini.");
  }
}

function metricCard(label, value, detail, tone) {
  const column = element("div", "col-sm-6 col-xl-3");
  const card = element("article", "card");
  const body = element("div", "card-body metric-card");
  const avatar = element("span", `avatar bg-${tone === "amber" ? "yellow" : tone}-lt`);
  const icon = document.createElement("img"); icon.className = "icon"; icon.src = "/vendor/tabler-icons/activity.svg"; icon.alt = "";
  avatar.append(icon);
  const copy = element("div"); copy.append(element("div", "text-secondary", label),
    element("div", "h2 mb-0", value), element("small", "text-secondary", detail));
  body.append(avatar, copy); card.append(body); column.append(card); return column;
}

async function loadNotifications() {
  const metrics = $("#notification-metrics"); const body = $("#notification-rows"); const holder = $("#notifications-state");
  metrics.replaceChildren(); body.replaceChildren(); setLoading(holder, "Memuat aktivitas…");
  const resources = await loadResources(api, [
    { key: "status", path: "/api/admin/notifications/status" },
    { key: "recent", path: "/api/admin/notifications/recent?limit=25" },
  ]);
  if (!state.authenticated) return;
  if (resources.status.available) {
    const data = resources.status.data;
    metrics.append(metricCard("Tertunda", Number(data.pending || 0), `${Number(data.processing || 0)} sedang diproses`, "amber"),
      metricCard("Terkirim", Number(data.delivered || 0), "Delivery selesai", "green"),
      metricCard("Gagal", Number(data.failed || 0), "Memerlukan perhatian", "violet"),
      metricCard("Belum dirutekan", Number(data.unrouted_escalations || 0), "Eskalasi tanpa tujuan", "blue"));
  } else {
    metrics.append(metricCard("Status notifikasi", "—", "Belum tersedia", "amber"));
  }
  if (!resources.recent.available) return unavailable(holder, "Aktivitas notifikasi belum dapat diakses.");
  const recent = Array.isArray(resources.recent.data) ? resources.recent.data : [];
  if (recent.length === 0) return emptyState(holder, "Belum ada aktivitas notifikasi.");
  for (const item of recent) {
    const row = document.createElement("tr"); const routing = element("td"); routing.append(badge(item.routing_status));
    const delivery = element("td"); delivery.append(badge(item.state));
    row.append(element("td", "", formatDate(item.created_at, true)), element("td", "", item.event_type), routing, delivery,
      element("td", "", String(item.attempt_count ?? 0))); body.append(row);
  }
  holder.hidden = true;
}

function systemCard(title, status, detail) {
  const column = element("div", "col-sm-6 col-xl-4");
  const card = element("article", "card system-card");
  const body = element("div", "card-body");
  body.append(element("h3", "card-title", title), badge(status), element("small", "text-secondary", detail));
  card.append(body); column.append(card); return column;
}

async function loadSystem() {
  const grid = $("#system-grid"); grid.replaceChildren(systemCard("Aplikasi", "PROCESSING", "Memeriksa kesehatan…"));
  const resources = await loadResources(api, [
    { key: "health", path: "/health" },
    { key: "automation", path: "/api/alerts/automation-status" },
    { key: "notifications", path: "/api/admin/notifications/status" },
  ]);
  if (!state.authenticated) return;
  grid.replaceChildren();
  grid.append(systemCard("Aplikasi", resources.health.available && resources.health.data.status === "ok" ? "HEALTHY" : "UNHEALTHY",
    resources.health.available ? "Endpoint /health merespons." : "Health tidak dapat diakses."));
  if (resources.automation.available) {
    const data = resources.automation.data;
    grid.append(systemCard("Telegram polling", data.telegramPolling, "Status runtime polling yang tersedia."),
      systemCard("Scheduler pengingat", data.reminderScheduler, "Kondisi otomasi pengingat."),
      systemCard("Evaluator peringatan", data.criticalAlertEvaluator, "Kondisi evaluasi alert."),
      systemCard("Delivery notifikasi", data.notificationDelivery, "Kondisi delivery tersimpan."),
      systemCard("Integrasi aktif", data.activeIntegrations, "Jumlah dari status otomasi."));
  } else {
    grid.append(systemCard("Telegram polling", "Belum tersedia", "Endpoint status otomasi tidak dapat diakses."),
      systemCard("Runtime integrasi", "Belum tersedia", "Detail runtime belum tersedia untuk sesi ini."));
  }
  if (resources.notifications.available) {
    const scheduler = resources.notifications.data.scheduler || {};
    grid.append(systemCard("Scheduler notifikasi", scheduler.enabled ? scheduler.last_status : "DEGRADED",
      scheduler.enabled ? `Terakhir selesai ${formatDate(scheduler.last_completed_at, true)}` : "Scheduler dinonaktifkan."));
  }
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = $("#login-submit"); const notice = $("#login-notice");
  notice.hidden = true; submit.disabled = true; submit.textContent = "Memeriksa…";
  try {
    const payload = await api("/api/admin/auth/login", { method: "POST", handleUnauthorized: false,
      body: JSON.stringify({ email: $("#login-email").value.trim(), password: $("#login-password").value }) });
    $("#login-password").value = ""; enterApplication(payload.data);
  } catch (error) {
    notice.classList.remove("info"); notice.textContent = loginErrorMessage(error); notice.hidden = false;
  } finally {
    submit.disabled = false; submit.textContent = "Masuk ke Sotoayam";
  }
});

$("#logout").addEventListener("click", async () => {
  try {
    await api("/api/admin/auth/logout", { method: "POST", handleUnauthorized: false });
    showLogin("Anda telah keluar dari Sotoayam.", true);
  } catch (error) {
    if (error.status === 401) showLogin("Sesi Anda telah berakhir. Silakan masuk kembali.");
    else showGlobal("Logout belum berhasil. Periksa koneksi lalu coba lagi.");
  }
});

$$('[data-view]').forEach((button) => button.addEventListener("click", () => void navigate(button.dataset.view)));
$$('[data-go]').forEach((button) => button.addEventListener("click", () => void navigate(button.dataset.go)));
$$('[data-refresh]').forEach((button) => button.addEventListener("click", () => void navigate(button.dataset.refresh)));
$("#menu-toggle").addEventListener("click", () => $("#app-shell").classList.toggle("nav-open"));
$("#task-status").addEventListener("change", () => void loadTasks());
$("#integration-rows").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-integration-id]");
  const integration = button && state.integrations.find((item) => String(item.id) === button.dataset.integrationId);
  if (integration) void loadCredentials(integration);
});
$("#close-credentials").addEventListener("click", () => { $("#credential-panel").hidden = true; });
window.addEventListener("hashchange", () => { if (state.authenticated) void navigate(location.hash.slice(1)); });

void api("/api/admin/auth/session", { handleUnauthorized: false })
  .then((payload) => enterApplication(payload.data))
  .catch(() => showLogin());
