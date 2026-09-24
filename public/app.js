import { allowedTaskStatusTransitions, bindResettableDialog, cancelTask, createApiClient, createManualTask, loadResources, loginErrorMessage, setDialogBusy, taskSummary, transitionTask, updateTask } from "./ui-core.js";
import { setupUsersView } from "./users.js";
import { setupSettingsView } from "./settings.js";
import { statusLabels, uiFormatters, uiMessages } from "./messages.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = { authenticated: false, principal: null, tasks: [], integrations: [] };
let selectedTask = null;
let pendingTestRequestId = null;
const titles = uiMessages.navigation;

const api = createApiClient({ csrfCookieName: () => state.principal?.csrf_cookie_name, onUnauthorized: () => {
  if (state.authenticated) showLogin(uiMessages.auth.sessionExpired);
} });
let usersView;
let settingsView;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function badge(value) {
  const normalized = String(value || "UNKNOWN").toLowerCase();
  const tones = { open: "bg-blue-lt", in_progress: "bg-azure-lt", blocked: "bg-red-lt", completed: "bg-green-lt",
    cancelled: "bg-secondary-lt", draft: "bg-secondary-lt", active: "bg-green-lt", inactive: "bg-secondary-lt",
    pending: "bg-yellow-lt", processing: "bg-blue-lt", delivered: "bg-green-lt", failed: "bg-red-lt",
    unrouted: "bg-orange-lt", healthy: "bg-green-lt", degraded: "bg-yellow-lt", unhealthy: "bg-red-lt",
    warning: "bg-yellow-lt", high: "bg-orange-lt", critical: "bg-red-lt", acknowledged: "bg-blue-lt",
    expired: "bg-secondary-lt", revoked: "bg-red-lt" };
  return element("span", `badge ${tones[normalized] || "bg-secondary-lt"}`,
    statusLabels[normalized] || String(value || uiMessages.common.unavailable));
}

function formatDate(value, includeTime = false) {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat("id-ID", includeTime
    ? { dateStyle: "medium", timeStyle: "short" }
    : { day: "2-digit", month: "short", year: "numeric" }).format(new Date(value));
}

function unavailable(container, detail = uiMessages.common.unavailableDetail) {
  const box = element("div", "alert alert-secondary mb-0 unavailable");
  box.append(element("strong", "", uiMessages.common.unavailable), element("span", "", detail));
  container.replaceChildren(box);
  container.classList.remove("loading");
}

function emptyState(container, detail) {
  const box = element("div", "empty py-4");
  box.append(element("p", "empty-title", uiMessages.common.emptyTitle), element("p", "empty-subtitle text-secondary", detail));
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
  $("#password-change-view").hidden = true;
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
  if (principal.password_change_required) {
    $("#app-shell").hidden = true;
    $("#password-change-view").hidden = false;
    $("#current-password").focus();
    return;
  }
  $("#password-change-view").hidden = true;
  $("#app-shell").hidden = false;
  $("#account-name").textContent = principal.display_name || uiMessages.common.administrator;
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
  if (selected === "users") await usersView.load();
  if (selected === "system") await loadSystem();
}

function renderDashboardTasks(tasks) {
  const container = $("#dashboard-tasks");
  const active = tasks.filter((task) => !["COMPLETED", "CANCELLED"].includes(task.status))
    .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at)).slice(0, 6);
  if (active.length === 0) return emptyState(container, uiMessages.dashboard.noActiveTasks);
  const list = element("div", "task-list");
  for (const task of active) {
    const row = element("div", "task-row");
    const copy = element("div");
    copy.append(element("p", "item-title", task.title), element("p", "item-meta",
      uiFormatters.taskUpdated(task.id, formatDate(task.updated_at, true))));
    row.append(copy, badge(task.status), badge(task.priority));
    list.append(row);
  }
  container.className = "card-body";
  container.replaceChildren(list);
}

function renderDashboardAlerts(resource) {
  const container = $("#dashboard-alerts");
  if (!resource.available) return unavailable(container, uiMessages.dashboard.alertsForbidden);
  const alerts = Array.isArray(resource.data) ? resource.data.slice(0, 5) : [];
  if (alerts.length === 0) return emptyState(container, uiMessages.dashboard.noAlerts);
  const list = element("div", "alert-list");
  for (const alert of alerts) {
    const row = element("div", "alert-row");
    const copy = element("div");
    copy.append(element("p", "item-title", alert.summary || alert.type),
      element("p", "item-meta", uiFormatters.alertMeta(alert.affectedReference, formatDate(alert.lastDetectedAt, true))));
    row.append(badge(alert.severity), copy);
    list.append(row);
  }
  container.className = "card-body";
  container.replaceChildren(list);
}

async function loadDashboard() {
  setLoading($("#dashboard-tasks"), uiMessages.dashboard.loadingTasks);
  setLoading($("#dashboard-alerts"), uiMessages.dashboard.loadingAlerts);
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
    $("#metric-task-detail").textContent = uiFormatters.taskMetrics(summary);
    renderDashboardTasks(state.tasks);
  } else {
    $("#metric-task-total").textContent = uiMessages.common.dash;
    $("#metric-task-detail").textContent = uiMessages.common.unavailable;
    unavailable($("#dashboard-tasks"));
  }
  if (resources.integrations.available) {
    state.integrations = Array.isArray(resources.integrations.data) ? resources.integrations.data : [];
    const active = state.integrations.filter((item) => item.active).length;
    $("#metric-integration-active").textContent = String(active);
    $("#metric-integration-detail").textContent = uiFormatters.integrationMetrics(state.integrations.length);
  } else {
    $("#metric-integration-active").textContent = uiMessages.common.dash;
    $("#metric-integration-detail").textContent = uiMessages.common.unavailable;
  }
  if (resources.notifications.available) {
    const data = resources.notifications.data;
    $("#metric-notification-pending").textContent = String(Number(data.pending || 0) + Number(data.processing || 0));
    $("#metric-notification-detail").textContent = uiFormatters.notificationMetrics(Number(data.failed || 0), Number(data.delivered || 0));
  } else {
    $("#metric-notification-pending").textContent = uiMessages.common.dash;
    $("#metric-notification-detail").textContent = uiMessages.common.unavailable;
  }
  if (resources.health.available) {
    $("#metric-health").textContent = resources.health.data.status === "ok" ? uiMessages.dashboard.healthy : uiMessages.dashboard.attention;
    $("#metric-health-detail").textContent = resources.automation.available
      ? `Otomasi: ${resources.automation.data.overall || "belum tersedia"}` : uiMessages.dashboard.automationUnavailable;
  } else {
    $("#metric-health").textContent = uiMessages.common.dash;
    $("#metric-health-detail").textContent = uiMessages.common.unavailable;
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
  const action = element("td"); const detail = element("button", "btn btn-sm btn-outline-secondary", uiMessages.tasks.detail);
  detail.type = "button"; detail.dataset.taskId = String(task.id); action.append(detail);
  row.append(title, status, priority, element("td", "", `Divisi #${task.owner_division_id}`),
    element("td", "", task.deadline ? formatDate(task.deadline, true) : uiMessages.tasks.noDeadline), action);
  return row;
}

async function openTaskDetail(id) {
  const panel = $("#task-detail"); const body = $("#task-detail-body");
  panel.hidden = false; body.textContent = uiMessages.tasks.loading;
  $("#task-action-error").hidden = true;
  try {
    const payload = await api(`/api/tasks/${id}`); const task = payload.data; selectedTask = task;
    $("#task-detail-title").textContent = `${uiMessages.tasks.detail} #${task.id}`;
    body.replaceChildren(element("h4", "", task.title), element("p", "", task.description || uiMessages.tasks.noDescription));
    const facts = element("div", "user-detail-facts");
    facts.append(badge(task.status), badge(task.priority),
      element("p", "", `${uiMessages.tasks.owner}: Divisi #${task.owner_division_id}`),
      element("p", "", `${uiMessages.tasks.assignee}: ${task.assigned_to_user_id ? `#${task.assigned_to_user_id}` : uiMessages.tasks.unassigned}`),
      element("p", "", `${uiMessages.tasks.deadline}: ${task.deadline ? formatDate(task.deadline, true) : uiMessages.tasks.noDeadline}`));
    body.append(facts);
    $("#edit-task").hidden = ["CANCELLED", "COMPLETED"].includes(task.status);
    $("#change-task-status").hidden = allowedTaskStatusTransitions(task.status).length === 0;
    $("#cancel-task").hidden = ["CANCELLED", "COMPLETED"].includes(task.status);
  } catch (error) { selectedTask = null; body.textContent = error.message || uiMessages.tasks.loadFailed;
    $("#edit-task").hidden = true; $("#change-task-status").hidden = true; $("#cancel-task").hidden = true; }
}

function datetimeLocal(value) {
  if (!value) return "";
  const date = new Date(value); if (!Number.isFinite(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

async function loadTasks() {
  const holder = $("#tasks-state");
  const body = $("#task-rows");
  body.replaceChildren(); setLoading(holder, uiMessages.tasks.loading);
  const status = $("#task-status").value;
  try {
    const payload = await api(`/api/tasks${status ? `?status=${encodeURIComponent(status)}` : ""}`);
    state.tasks = Array.isArray(payload.data) ? payload.data : [];
    if (state.tasks.length === 0) return emptyState(holder, uiMessages.tasks.empty);
    body.replaceChildren(...state.tasks.map(taskRow));
    holder.hidden = true;
  } catch (error) {
    if (error.status !== 401) unavailable(holder, uiMessages.tasks.loadFailed);
  }
}

async function loadCredentials(integration) {
  const panel = $("#credential-panel");
  const list = $("#credential-list");
  panel.hidden = false;
  $("#credential-title").textContent = uiFormatters.credentialTitle(integration.name);
  setLoading(list, uiMessages.integrations.credentialLoading);
  try {
    const payload = await api(`/api/admin/integrations/${integration.id}/credentials`);
    const credentials = Array.isArray(payload.data) ? payload.data : [];
    if (credentials.length === 0) return emptyState(list, uiMessages.integrations.credentialEmpty);
    const wrapper = element("div", "credential-list");
    for (const credential of credentials) {
      const row = element("div", "credential-row");
      const copy = element("div");
      copy.append(element("p", "item-title", credential.label), element("p", "item-meta",
        uiFormatters.credentialMeta(credential.selector, formatDate(credential.last_used_at, true))));
      row.append(copy, badge(credential.status)); wrapper.append(row);
    }
    list.className = "card-body"; list.replaceChildren(wrapper);
  } catch (error) {
    if (error.status !== 401) unavailable(list, uiMessages.integrations.credentialForbidden);
  }
}

async function loadIntegrations() {
  const holder = $("#integrations-state"); const body = $("#integration-rows");
  body.replaceChildren(); $("#credential-panel").hidden = true; setLoading(holder, uiMessages.integrations.loading);
  try {
    const payload = await api("/api/admin/integrations");
    state.integrations = Array.isArray(payload.data) ? payload.data : [];
    if (state.integrations.length === 0) return emptyState(holder, uiMessages.integrations.empty);
    for (const integration of state.integrations) {
      const row = document.createElement("tr");
      const name = element("td"); name.append(element("span", "cell-title", integration.name), element("span", "cell-subtitle", integration.code));
      const status = element("td"); status.append(badge(integration.active ? "ACTIVE" : "INACTIVE"));
      const action = element("td"); const button = element("button", "table-action", uiMessages.integrations.viewMetadata);
      button.type = "button"; button.dataset.integrationId = String(integration.id); action.append(button);
      row.append(name, element("td", "", integration.source), element("td", "", `Divisi #${integration.requesting_division_id}`), status, action);
      body.append(row);
    }
    holder.hidden = true;
  } catch (error) {
    if (error.status !== 401) unavailable(holder, uiMessages.integrations.loadFailed);
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
  metrics.replaceChildren(); body.replaceChildren(); setLoading(holder, uiMessages.notifications.loading);
  const resources = await loadResources(api, [
    { key: "status", path: "/api/admin/notifications/status" },
    { key: "recent", path: "/api/admin/notifications/recent?limit=25" },
  ]);
  if (!state.authenticated) return;
  if (resources.status.available) {
    const data = resources.status.data;
    metrics.append(metricCard(uiMessages.notifications.pending, Number(data.pending || 0), uiFormatters.processingCount(Number(data.processing || 0)), "amber"),
      metricCard(uiMessages.notifications.sent, Number(data.delivered || 0), uiMessages.notifications.deliveryFinished, "green"),
      metricCard(uiMessages.notifications.failed, Number(data.failed || 0), uiMessages.notifications.attention, "violet"),
      metricCard(uiMessages.notifications.unrouted, Number(data.unrouted_escalations || 0), uiMessages.notifications.noDestination, "blue"));
  } else {
    metrics.append(metricCard(uiMessages.notifications.status, uiMessages.common.dash, uiMessages.common.unavailable, "amber"));
  }
  if (!resources.recent.available) return unavailable(holder, uiMessages.notifications.forbidden);
  const recent = Array.isArray(resources.recent.data) ? resources.recent.data : [];
  if (recent.length === 0) return emptyState(holder, uiMessages.notifications.empty);
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
  const grid = $("#system-grid"); grid.replaceChildren(systemCard(uiMessages.system.application, "PROCESSING", uiMessages.system.checking));
  const resources = await loadResources(api, [
    { key: "health", path: "/health" },
    { key: "readiness", path: "/ready", options: { acceptStatuses: [503] } },
    { key: "automation", path: "/api/alerts/automation-status" },
    { key: "notifications", path: "/api/admin/notifications/status" },
  ]);
  if (!state.authenticated) return;
  grid.replaceChildren();
  grid.append(systemCard(uiMessages.system.application, resources.health.available && resources.health.data.status === "ok" ? "HEALTHY" : "UNHEALTHY",
    resources.health.available ? uiMessages.system.healthResponding : uiMessages.system.healthUnavailable));
  const readinessCard = $("#readiness-card");
  if (resources.readiness.available) {
    const readiness = resources.readiness.data;
    const checks = readiness.checks || {};
    const warningText = uiFormatters.readinessWarnings(Array.isArray(readiness.warnings) ? readiness.warnings : []);
    readinessCard.replaceChildren(
      badge(readiness.status),
      element("p", "mt-3 mb-1", uiFormatters.readinessChecks(checks)),
      element("small", "text-secondary", warningText),
    );
  } else {
    readinessCard.replaceChildren(element("div", "alert alert-danger mb-0", uiMessages.system.readinessUnavailable));
  }
  if (resources.automation.available) {
    const data = resources.automation.data;
    grid.append(systemCard(uiMessages.system.telegramPolling, data.telegramPolling, uiMessages.system.pollingDetail),
      systemCard(uiMessages.system.reminderScheduler, data.reminderScheduler, uiMessages.system.reminderDetail),
      systemCard(uiMessages.system.alertEvaluator, data.criticalAlertEvaluator, uiMessages.system.alertDetail),
      systemCard(uiMessages.system.notificationDelivery, data.notificationDelivery, uiMessages.system.deliveryDetail),
      systemCard(uiMessages.system.activeIntegrations, data.activeIntegrations, uiMessages.system.integrationCountDetail));
  } else {
    grid.append(systemCard(uiMessages.system.telegramPolling, uiMessages.common.unavailable, uiMessages.system.automationUnavailable),
      systemCard(uiMessages.system.integrationRuntime, uiMessages.common.unavailable, uiMessages.system.runtimeUnavailable));
  }
  if (resources.notifications.available) {
    const scheduler = resources.notifications.data.scheduler || {};
    grid.append(systemCard(uiMessages.system.notificationScheduler, scheduler.enabled ? scheduler.last_status : "DEGRADED",
      scheduler.enabled ? uiFormatters.schedulerCompleted(formatDate(scheduler.last_completed_at, true)) : uiMessages.system.schedulerDisabled));
  }
  await settingsView.load();
  await loadTestRecipients();
}

async function loadTestRecipients() {
  const card = $("#test-notification-card");
  const select = $("#test-notification-recipient");
  card.hidden = true;
  try {
    const payload = await api(`/api/admin/notifications/test-recipients?type=${encodeURIComponent($("#test-notification-type").value)}`);
    const recipients = Array.isArray(payload.data) ? payload.data : [];
    select.replaceChildren(...recipients.map((item) => new Option(item.display_name, String(item.id))));
    $("#test-notification-send").disabled = recipients.length === 0;
    $("#test-notification-result").textContent = recipients.length === 0 ? uiMessages.testNotification.none : "";
    $("#test-notification-result").hidden = recipients.length !== 0;
    card.hidden = false;
  } catch (error) {
    if (error.status !== 401 && error.status !== 403) {
      card.hidden = false;
      $("#test-notification-send").disabled = true;
      $("#test-notification-result").textContent = uiMessages.testNotification.unavailable;
      $("#test-notification-result").hidden = false;
    }
  }
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = $("#login-submit"); const notice = $("#login-notice");
  notice.hidden = true; submit.disabled = true; submit.textContent = uiMessages.auth.checking;
  try {
    const payload = await api("/api/admin/auth/login", { method: "POST", handleUnauthorized: false,
      body: JSON.stringify({ email: $("#login-email").value.trim(), password: $("#login-password").value }) });
    $("#login-password").value = ""; enterApplication(payload.data);
  } catch (error) {
    notice.classList.remove("info"); notice.textContent = loginErrorMessage(error); notice.hidden = false;
  } finally {
    submit.disabled = false; submit.textContent = uiMessages.auth.login;
  }
});

async function logout() {
  try {
    await api("/api/admin/auth/logout", { method: "POST", handleUnauthorized: false });
    showLogin(uiMessages.auth.loggedOut, true);
  } catch (error) {
    if (error.status === 401) showLogin(uiMessages.auth.sessionExpired);
    else showGlobal(uiMessages.auth.logoutFailed);
  }
}

$("#logout").addEventListener("click", () => void logout());
$("#restricted-logout").addEventListener("click", () => void logout());
$("#required-password-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const notice = $("#password-change-notice"); notice.hidden = true;
  try {
    await api("/api/admin/auth/password", { method: "POST", body: JSON.stringify({
      current_password: $("#current-password").value, new_password: $("#new-password").value,
    }) });
    $("#current-password").value = ""; $("#new-password").value = "";
    enterApplication({ ...state.principal, password_change_required: false });
  } catch (error) {
    notice.textContent = error.message || uiMessages.auth.passwordChangeFailed; notice.hidden = false;
  }
});

usersView = setupUsersView({ api, badge, formatDate, showGlobal });
settingsView = setupSettingsView({ api, showGlobal });

$$('[data-view]').forEach((button) => button.addEventListener("click", () => void navigate(button.dataset.view)));
$$('[data-go]').forEach((button) => button.addEventListener("click", () => void navigate(button.dataset.go)));
$$('[data-refresh]').forEach((button) => button.addEventListener("click", () => void navigate(button.dataset.refresh)));
$("#menu-toggle").addEventListener("click", () => $("#app-shell").classList.toggle("nav-open"));
$("#task-status").addEventListener("change", () => void loadTasks());
$("#test-notification-type").replaceChildren(...Object.entries(uiMessages.testNotification.types)
  .map(([code, label]) => new Option(label, code)));
$("#test-notification-type").addEventListener("change", () => { pendingTestRequestId = null; void loadTestRecipients(); });
$("#test-notification-recipient").addEventListener("change", () => { pendingTestRequestId = null; });
$("#test-notification-send").addEventListener("click", async () => {
  const recipient = Number($("#test-notification-recipient").value);
  const type = $("#test-notification-type").value;
  if (!Number.isSafeInteger(recipient) || recipient < 1 || !window.confirm(uiMessages.testNotification.confirm)) return;
  const button = $("#test-notification-send");
  const result = $("#test-notification-result");
  pendingTestRequestId ||= crypto.randomUUID();
  button.disabled = true;
  result.textContent = uiMessages.testNotification.sending;
  result.hidden = false;
  try {
    const payload = await api("/api/admin/notifications/test", { method: "POST",
      body: JSON.stringify({ recipient_user_id: recipient, request_id: pendingTestRequestId, type }) });
    result.textContent = payload.data.sent === 1 && payload.data.failed === 0
      ? uiMessages.testNotification.success : uiMessages.testNotification.failed;
    pendingTestRequestId = null;
    await loadNotifications().catch(() => undefined);
  } catch (error) {
    result.textContent = error.message || uiMessages.testNotification.failed;
    if (error.status >= 400 && error.status < 500) pendingTestRequestId = null;
  } finally { button.disabled = false; }
});
$$('[data-create-task]').forEach((button) => button.addEventListener("click", () => {
  $("#create-task-error").hidden = true;
  $("#create-task-dialog").showModal();
}));
for (const name of ["create-task", "edit-task", "status-task", "cancel-task"]) {
  bindResettableDialog($(`#${name}-dialog`), $(`#${name}-form`), $(`#${name}-error`));
}
$("#task-rows").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-task-id]");
  if (button) void openTaskDetail(button.dataset.taskId);
});
$("#close-task-detail").addEventListener("click", () => { $("#task-detail").hidden = true; selectedTask = null; });
$("#edit-task").addEventListener("click", () => {
  if (!selectedTask) return;
  const form = $("#edit-task-form");
  form.elements.title.value = selectedTask.title;
  form.elements.description.value = selectedTask.description || "";
  form.elements.priority.value = selectedTask.priority;
  form.elements.deadline.value = datetimeLocal(selectedTask.deadline);
  $("#edit-task-dialog").showModal();
});
$("#edit-task-form").addEventListener("submit", async (event) => {
  event.preventDefault(); if (!selectedTask) return;
  const form = event.currentTarget; const id = selectedTask.id;
  const submit = $("#edit-task-submit"); const error = $("#edit-task-error");
  if (submit.disabled) return;
  submit.disabled = true; setDialogBusy($("#edit-task-dialog"), true); error.hidden = true;
  try {
    await updateTask(api, id, { title: form.elements.title.value, description: form.elements.description.value,
      priority: form.elements.priority.value, deadline: form.elements.deadline.value });
    $("#edit-task-dialog").close(); await Promise.all([loadTasks(), openTaskDetail(id)]);
    showGlobal(uiMessages.tasks.updated);
  } catch (caught) { error.textContent = caught.message || uiMessages.tasks.updateFailed; error.hidden = false; }
  finally { submit.disabled = false; setDialogBusy($("#edit-task-dialog"), false); }
});
function syncStatusNoteField() {
  const form = $("#status-task-form");
  const blocked = form.elements.status.value === "BLOCKED";
  $("#status-task-note-field").hidden = !blocked;
  form.elements.note.required = blocked;
}
$("#change-task-status").addEventListener("click", () => {
  if (!selectedTask) return;
  const select = $("#status-task-form").elements.status;
  select.replaceChildren(...allowedTaskStatusTransitions(selectedTask.status).map((status) => {
    const option = element("option", "", statusLabels[status.toLowerCase()] || status); option.value = status; return option;
  }));
  syncStatusNoteField();
  $("#status-task-dialog").showModal();
});
$("#status-task-form").elements.status.addEventListener("change", syncStatusNoteField);
$("#status-task-form").addEventListener("submit", async (event) => {
  event.preventDefault(); if (!selectedTask) return;
  const id = selectedTask.id; const form = event.currentTarget;
  const submit = $("#status-task-submit"); const error = $("#status-task-error");
  if (submit.disabled) return;
  submit.disabled = true; setDialogBusy($("#status-task-dialog"), true); error.hidden = true;
  try {
    await transitionTask(api, id, form.elements.status.value, form.elements.note.value);
    $("#status-task-dialog").close(); await Promise.all([loadTasks(), openTaskDetail(id)]);
    showGlobal(uiMessages.tasks.statusChanged);
  } catch (caught) { error.textContent = caught.message || uiMessages.tasks.statusChangeFailed; error.hidden = false; }
  finally { submit.disabled = false; setDialogBusy($("#status-task-dialog"), false); }
});
$("#cancel-task").addEventListener("click", () => {
  if (selectedTask) $("#cancel-task-dialog").showModal();
});
$("#cancel-task-form").addEventListener("submit", async (event) => {
  event.preventDefault(); if (!selectedTask) return;
  const id = selectedTask.id; const form = event.currentTarget;
  const submit = $("#cancel-task-submit"); const error = $("#cancel-task-error");
  if (submit.disabled) return;
  submit.disabled = true; setDialogBusy($("#cancel-task-dialog"), true); error.hidden = true;
  try {
    await cancelTask(api, id, form.elements.note.value);
    $("#cancel-task-dialog").close(); await Promise.all([loadTasks(), openTaskDetail(id)]);
    showGlobal(uiMessages.tasks.cancelled);
  } catch (caught) { error.textContent = caught.message || uiMessages.tasks.cancelFailed; error.hidden = false; }
  finally { submit.disabled = false; setDialogBusy($("#cancel-task-dialog"), false); }
});
$("#create-task-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const errorBox = $("#create-task-error");
  const submit = $("#create-task-submit");
  if (submit.disabled) return;
  errorBox.hidden = true;
  submit.disabled = true; setDialogBusy($("#create-task-dialog"), true);
  try {
    await createManualTask(api, { title: form.elements.title.value, description: form.elements.description.value,
      priority: form.elements.priority.value, deadline: form.elements.deadline.value,
      assignedToUserId: form.elements.assign_to_self.checked ? state.principal?.user_id : null });
    $("#create-task-dialog").close();
    if (location.hash === "#dashboard") await loadDashboard();
    else await loadTasks();
    showGlobal(uiMessages.tasks.created);
  } catch (error) {
    errorBox.textContent = error.status === 403 ? uiMessages.tasks.createForbidden : error.message || uiMessages.tasks.createFailed;
    errorBox.hidden = false;
  } finally { submit.disabled = false; setDialogBusy($("#create-task-dialog"), false); }
});
$("#integration-rows").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-integration-id]");
  const integration = button && state.integrations.find((item) => String(item.id) === button.dataset.integrationId);
  if (integration) void loadCredentials(integration);
});
$("#close-credentials").addEventListener("click", () => { $("#credential-panel").hidden = true; });
window.addEventListener("hashchange", () => { if (state.authenticated) void navigate(location.hash.slice(1)); });

async function initializeApplication() {
  try {
    const setup = await api("/api/setup/status", { handleUnauthorized: false });
    if (setup?.data?.required) {
      location.replace("/setup");
      return;
    }
  } catch {
    showLogin("Status penyiapan Sotoayam tidak dapat diperiksa.");
    return;
  }
  try {
    const payload = await api("/api/admin/auth/session", { handleUnauthorized: false });
    enterApplication(payload.data);
  } catch {
    const completed = new URLSearchParams(location.search).get("setup") === "complete";
    showLogin(completed ? "Penyiapan selesai. Masuk menggunakan akun OWNER yang baru dibuat." : "", completed);
    if (completed) history.replaceState(null, "", "/");
  }
}

void initializeApplication();
