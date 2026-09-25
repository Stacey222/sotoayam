import { uiFormatters, uiMessages } from "./messages.js";

export function setupSettingsView({ api, showGlobal }) {
  const $ = (selector) => document.querySelector(selector);
  const state = { settings: null, canEditRuntime: false, canDesignate: false };
  const policyFields = ["overdue.warningHours", "overdue.highHours", "overdue.criticalHours",
    "blocked.warningHours", "blocked.highHours", "blocked.criticalHours", "scheduler.staleMinutes", "scheduler.criticalMinutes"];
  const at = (object, path) => path.split(".").reduce((value, key) => value[key], object);
  function notice(message, danger = true) { const node = $("#settings-notice"); node.textContent = message; node.className = `alert ${danger ? "alert-danger" : "alert-success"}`; node.hidden = !message; }
  function render(data) {
    state.settings = data; const runtime = data.runtime;
    $("#settings-source").textContent = data.source === "RUNTIME" ? uiMessages.settings.runtime : uiMessages.settings.deploymentDefault;
    $("#settings-timezone").value = runtime.business_time_zone;
    $("#settings-interval").value = runtime.reminder_scheduler_interval_seconds;
    for (const name of policyFields) $("#settings-form").elements[name].value = at(runtime.critical_alert_policy, name);
    $("#settings-updated").textContent = data.updated_at ? uiFormatters.settingsUpdated(new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short" }).format(new Date(data.updated_at))) : uiMessages.settings.neverUpdated;
    $("#settings-business-current").textContent = data.business_actor?.display_name || uiMessages.settings.unset;
    $("#settings-save").hidden = !state.canEditRuntime;
    $("#settings-reason-row").hidden = !state.canEditRuntime;
    $("#settings-form").querySelectorAll("input").forEach((input) => { input.disabled = !state.canEditRuntime; });
    $("#business-actor-form").hidden = !state.canDesignate;
  }
  async function capabilities() {
    const results = await Promise.allSettled([api("/api/reports/task-status?window=TODAY"), api("/api/admin/users/authority-summary")]);
    state.canEditRuntime = results[0].status === "fulfilled";
    state.canDesignate = results[1].status === "fulfilled";
  }
  async function candidates() {
    if (!state.canDesignate) return;
    const payload = await api("/api/admin/users?status=active&has_login=true&limit=100");
    const select = $("#settings-business-actor"); select.replaceChildren(new Option(uiMessages.settings.chooseActor, ""));
    for (const user of payload.data || []) select.append(new Option(`${user.display_name} (${user.role?.code || "-"})`, user.id));
  }
  const preferenceLabels = uiMessages.testNotification.types;
  function onboardingNotice(message, danger = false) { const node = $("#telegram-onboarding-notice"); node.textContent = message;
    node.className = `alert ${danger ? "alert-danger" : "alert-success"}`; node.hidden = !message; }
  function renderTelegram(data) {
    $("#telegram-connection-badge").textContent = data.connected ? uiMessages.telegram.connected : uiMessages.telegram.notConnected;
    $("#telegram-connection-badge").className = `badge ${data.connected ? "bg-green-lt" : "bg-secondary-lt"} ms-auto`;
    const checks = [[uiMessages.telegram.ownerReady, data.readiness.owner_account],
      [uiMessages.telegram.settingsReady, data.readiness.business_settings],
      [uiMessages.telegram.connectionReady, data.readiness.telegram_connected],
      [uiMessages.telegram.preferencesReady, data.readiness.preferences_reviewed],
      [uiMessages.telegram.testReady, data.readiness.test_notification_sent]];
    $("#customer-readiness-list").replaceChildren(...checks.map(([label, done]) => {
      const item = document.createElement("li"); item.className = "list-group-item px-0";
      item.textContent = `${done ? "✓" : "○"} ${label}`; return item;
    }));
    $("#telegram-pair").hidden = data.connected; $("#telegram-pair-help").hidden = data.connected;
    const enabled = new Map(data.preferences.map((item) => [item.notification_type, item.enabled]));
    $("#telegram-preferences").replaceChildren(...data.supported_types.map((type) => {
      const label = document.createElement("label"); label.className = "form-check col-md-6 mb-2";
      const input = document.createElement("input"); input.type = "checkbox"; input.name = type;
      input.className = "form-check-input"; input.checked = enabled.get(type) === true; input.disabled = !data.connected;
      const span = document.createElement("span"); span.className = "form-check-label"; span.textContent = preferenceLabels[type];
      label.append(input, span); return label;
    }));
    $("#telegram-preferences-save").disabled = !data.connected;
  }
  async function loadTelegram() { const payload = await api("/api/admin/telegram-onboarding"); renderTelegram(payload.data); }
  async function load() {
    notice(""); $("#settings-state").hidden = false; $("#settings-content").hidden = true;
    try { await capabilities(); const payload = await api("/api/admin/settings"); render(payload.data); await candidates(); await loadTelegram();
      $("#settings-state").hidden = true; $("#settings-content").hidden = false;
    } catch (error) { notice(error.status === 403 ? uiMessages.settings.forbidden : uiMessages.settings.loadFailed); }
  }
  $("#telegram-pair").addEventListener("click", async () => {
    onboardingNotice("");
    try { const payload = await api("/api/admin/telegram-onboarding/pairings", { method: "POST", body: "{}" });
      window.open(payload.data.deep_link, "_blank", "noopener,noreferrer"); onboardingNotice(uiMessages.telegram.linkOpened);
      window.setTimeout(() => { void loadTelegram(); }, 2500);
    } catch (error) { onboardingNotice(error.message, true); }
  });
  $("#telegram-preferences-form").addEventListener("submit", async (event) => {
    event.preventDefault(); const values = {};
    for (const type of Object.keys(preferenceLabels)) values[type] = event.currentTarget.elements[type].checked;
    try { await api("/api/admin/telegram-onboarding/preferences", { method: "PUT", body: JSON.stringify(values) });
      onboardingNotice(uiMessages.telegram.preferencesSaved); await loadTelegram();
    } catch (error) { onboardingNotice(error.message, true); }
  });
  $("#settings-form").addEventListener("submit", async (event) => {
    event.preventDefault(); if (!state.settings || !confirm(uiMessages.settings.confirmRuntime)) return;
    const form = event.currentTarget; const policy = { overdue: {}, blocked: {}, scheduler: {} };
    for (const name of policyFields) { const [group, key] = name.split("."); policy[group][key] = Number(form.elements[name].value); }
    try { const payload = await api("/api/admin/settings/runtime", { method: "PATCH", body: JSON.stringify({
      expected_version: state.settings.version, business_time_zone: form.elements.business_time_zone.value,
      reminder_scheduler_interval_seconds: Number(form.elements.reminder_scheduler_interval_seconds.value),
      critical_alert_policy: policy, reason: form.elements.reason.value }) });
      form.elements.reason.value = ""; render(payload.data); notice(uiMessages.settings.updated, false);
    } catch (error) { notice(error.status === 409 ? uiMessages.settings.conflict : error.message); }
  });
  $("#business-actor-form").addEventListener("submit", async (event) => {
    event.preventDefault(); if (!state.settings || !confirm(uiMessages.settings.confirmActor)) return;
    const form = event.currentTarget;
    try { const payload = await api("/api/admin/settings/business-actor", { method: "PATCH", body: JSON.stringify({
      expected_version: state.settings.version, user_id: Number(form.elements.user_id.value), reason: form.elements.reason.value }) });
      form.elements.reason.value = ""; render(payload.data); notice(uiMessages.settings.actorUpdated, false);
    } catch (error) { notice(error.status === 409 ? uiMessages.settings.actorConflict : error.message); }
  });
  return { load };
}
