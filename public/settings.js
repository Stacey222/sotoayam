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
  async function load() {
    notice(""); $("#settings-state").hidden = false; $("#settings-content").hidden = true;
    try { await capabilities(); const payload = await api("/api/admin/settings"); render(payload.data); await candidates();
      $("#settings-state").hidden = true; $("#settings-content").hidden = false;
    } catch (error) { notice(error.status === 403 ? uiMessages.settings.forbidden : uiMessages.settings.loadFailed); }
  }
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
