import { uiFormatters, uiMessages } from "./messages.js";
import { bindResettableDialog, setDialogBusy } from "./ui-core.js";

const $ = (selector) => document.querySelector(selector);

function node(tag, className, text) {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text !== undefined) value.textContent = String(text);
  return value;
}

function errorMessage(error) {
  if (error?.status === 403) return uiMessages.users.systemAdminRequired;
  if (error?.status === 409) return error.message || uiMessages.users.lastAdminRejected;
  return error?.message || uiMessages.api.requestFailed;
}

export function createAdministrator(api, values) {
  return api("/api/admin/users", { method: "POST", body: JSON.stringify({
    display_name: values.display_name, email: values.email, division_id: Number(values.division_id),
    role_id: Number(values.role_id), grant_system_admin: values.grant_system_admin, reason: values.reason,
  }) });
}

export function changeUserActive(api, user, active) {
  return api(`/api/admin/users/${user.id}/access`, { method: "PATCH", body: JSON.stringify({
    division_id: user.division?.id ?? null, role_id: user.role?.id ?? null, active,
  }) });
}

export function setupUsersView({ api, badge, formatDate, showGlobal, onSessionRequired }) {
  const state = { users: [], nextCursor: null, catalogs: { divisions: [], roles: [] }, summary: null, selected: null };

  function accessBadges(user) {
    const box = node("div", "user-badges");
    for (const [show, label, tone] of [[user.system_admin, "SYSTEM_ADMIN", "ACTIVE"], [user.has_login, uiMessages.users.badges.login, "ACTIVE"],
      [user.telegram_connected, uiMessages.users.badges.telegram, "ACTIVE"], [user.is_current_user, uiMessages.users.badges.self, "PENDING"]]) {
      if (show) { const value = badge(tone); value.textContent = label; box.append(value); }
    }
    if (!box.childNodes.length) box.append(node("span", "text-secondary", "—"));
    return box;
  }

  function renderRows(append) {
    const body = $("#user-rows");
    if (!append) body.replaceChildren();
    for (const user of state.users) {
      if (append && body.querySelector(`[data-user-row="${user.id}"]`)) continue;
      const row = document.createElement("tr"); row.dataset.userRow = String(user.id);
      const identity = node("td"); identity.append(node("strong", "d-block", user.display_name || uiMessages.users.unnamed),
        node("small", "text-secondary", user.email || user.business_user_code || uiFormatters.userNumber(user.id)));
      const assignment = node("td"); assignment.append(node("span", "d-block", user.division?.name || uiMessages.users.noDivision),
        node("small", "text-secondary", user.role?.name || uiMessages.users.noRole));
      const status = node("td"); status.append(badge(user.active ? "ACTIVE" : "INACTIVE"));
      const badges = node("td"); badges.append(accessBadges(user));
      const action = node("td"); const button = node("button", "btn btn-sm btn-outline-secondary", uiMessages.users.detail);
      button.type = "button"; button.dataset.userId = String(user.id); action.append(button);
      row.append(identity, assignment, status, badges, action); body.append(row);
    }
    $("#users-state").hidden = state.users.length > 0;
    if (!state.users.length) $("#users-state").textContent = uiMessages.users.empty;
    $("#users-more").hidden = !state.nextCursor;
  }

  function query(cursor) {
    const params = new URLSearchParams({ limit: "25" });
    for (const [id, key] of [["#users-q", "q"], ["#users-status", "status"], ["#users-division", "division_id"],
      ["#users-authority", "system_admin"], ["#users-login", "has_login"]]) {
      const value = $(id).value.trim(); if (value) params.set(key, value);
    }
    if (cursor) params.set("cursor", cursor);
    return params.toString();
  }

  async function loadUsers({ append = false } = {}) {
    if (!append) { state.users = []; state.nextCursor = null; $("#user-rows").replaceChildren(); }
    $("#users-state").hidden = false; $("#users-state").textContent = uiMessages.users.loading;
    try {
      const payload = await api(`/api/admin/users?${query(append ? state.nextCursor : null)}`);
      const incoming = Array.isArray(payload.data) ? payload.data : [];
      const known = new Set(state.users.map((user) => user.id));
      state.users.push(...incoming.filter((user) => !known.has(user.id)));
      state.nextCursor = payload.pagination?.next_cursor || null; renderRows(append);
    } catch (error) {
      $("#users-state").textContent = errorMessage(error); $("#users-state").hidden = false;
    }
  }

  async function loadContext() {
    try {
      const [catalogs, summary] = await Promise.all([api("/api/admin/users/catalogs"), api("/api/admin/users/authority-summary")]);
      state.catalogs = catalogs.data; state.summary = summary.data;
      $("#users-summary").textContent = uiFormatters.authoritySummary(summary.data.effective_system_admins, summary.data.you_are_last);
      const divisionOptions = state.catalogs.divisions.map((item) => new Option(item.name, item.id));
      $("#users-division").append(...divisionOptions.map((item) => item.cloneNode(true)));
      const form = $("#create-user-form");
      form.elements.division_id.replaceChildren(...divisionOptions.map((item) => item.cloneNode(true)));
      form.elements.role_id.replaceChildren(...state.catalogs.roles.map((item) => new Option(item.name, item.id)));
    } catch (error) { $("#users-summary").className = "alert alert-danger"; $("#users-summary").textContent = errorMessage(error); }
  }

  function input(label, name, value, type = "text") {
    const holder = node("label", "form-label", label); const field = document.createElement("input");
    field.name = name; field.type = type; field.className = "form-control"; field.defaultValue = value ?? ""; holder.append(field); return holder;
  }

  function select(label, name, values, current) {
    const holder = node("label", "form-label", label); const field = document.createElement("select");
    field.name = name; field.className = "form-select";
    field.append(new Option(uiMessages.users.unset, "", !current, !current),
      ...values.map((item) => new Option(item.name, item.id, Number(item.id) === Number(current), Number(item.id) === Number(current))));
    holder.append(field); return holder;
  }

  function cancelEdit(form) {
    const button = node("button", "btn btn-link", uiMessages.users.cancel);
    button.type = "button"; button.addEventListener("click", () => form.reset()); form.append(button);
  }

  async function mutation(path, method, body) {
    try { const payload = await api(path, { method, body: JSON.stringify(body) }); showGlobal(""); return payload; }
    catch (error) { showGlobal(errorMessage(error)); throw error; }
  }

  async function showTemporary(value) {
    const dialog = $("#temporary-password-dialog"); const output = $("#temporary-password");
    output.textContent = value; $("#temporary-password-saved").checked = false; $("#close-temporary-password").disabled = true;
    dialog.showModal();
  }

  async function openDetail(id) {
    const panel = $("#user-detail"); const body = $("#user-detail-body"); panel.hidden = false; body.textContent = uiMessages.users.detailLoading;
    try {
      const payload = await api(`/api/admin/users/${id}`); const user = payload.data; state.selected = user;
      $("#user-detail-title").textContent = user.display_name || uiFormatters.userNumber(user.id); body.replaceChildren();
      const facts = node("div", "user-detail-facts"); facts.append(node("p", "", user.email || uiMessages.users.loginUnavailable),
        node("p", "text-secondary", uiFormatters.userCreated(formatDate(user.created_at, true))), accessBadges(user)); body.append(facts);

      const profile = node("form", "user-action"); profile.append(node("h4", "", uiMessages.users.profile), input(uiMessages.users.displayName, "display_name", user.display_name), node("button", "btn btn-outline-secondary", uiMessages.users.saveProfile));
      profile.querySelector("button").type = "submit"; cancelEdit(profile);
      profile.addEventListener("submit", async (event) => { event.preventDefault(); await mutation(`/api/admin/users/${id}/profile`, "PATCH", { display_name: profile.elements.display_name.value }); await openDetail(id); await loadUsers(); });
      body.append(profile);

      const access = node("form", "user-action"); access.append(node("h4", "", uiMessages.users.access), select(uiMessages.users.division, "division_id", state.catalogs.divisions, user.division?.id),
        select(uiMessages.users.role, "role_id", state.catalogs.roles, user.role?.id));
      const active = node("label", "form-check"); const activeBox = document.createElement("input"); activeBox.type = "checkbox"; activeBox.name = "active"; activeBox.defaultChecked = user.active; activeBox.disabled = user.is_current_user; activeBox.className = "form-check-input"; active.append(activeBox, node("span", "form-check-label", user.is_current_user ? uiMessages.users.ownActive : uiMessages.users.active));
      access.append(active, input(uiMessages.users.selfDemotionReason, "reason", ""), node("button", "btn btn-outline-secondary", uiMessages.users.saveAccess));
      access.querySelector("button").type = "submit"; cancelEdit(access);
      if (!user.is_current_user) {
        const lifecycle = node("button", user.active ? "btn btn-outline-danger" : "btn btn-outline-secondary",
          user.active ? uiMessages.users.deactivate : uiMessages.users.reactivate);
        lifecycle.type = "button";
        lifecycle.addEventListener("click", async () => {
          if (!confirm(user.active ? uiMessages.users.confirmDeactivate : uiMessages.users.confirmReactivate)) return;
          lifecycle.disabled = true;
          try {
            await changeUserActive(api, user, !user.active);
            await openDetail(id); await Promise.all([loadUsers(), loadSummary()]);
          } catch (error) { showGlobal(errorMessage(error)); }
          finally { lifecycle.disabled = false; }
        });
        access.append(lifecycle);
      }
      access.addEventListener("submit", async (event) => { event.preventDefault();
        const selectedDivision = state.catalogs.divisions.find((item) => Number(item.id) === Number(access.elements.division_id.value));
        const demotion = user.is_current_user && user.effective_system_admin
          && (!selectedDivision?.active || selectedDivision.grants_system_authority !== true);
        if (!confirm(uiMessages.users.confirmAccess)) return;
        await mutation(`/api/admin/users/${id}/access`, "PATCH", { division_id: Number(access.elements.division_id.value) || null,
          role_id: Number(access.elements.role_id.value) || null, active: access.elements.active.checked, confirm: demotion,
          reason: demotion ? access.elements.reason.value : null }); await openDetail(id); await Promise.all([loadUsers(), loadSummary()]); });
      body.append(access);

      if (!user.has_login && user.active) {
        const login = node("form", "user-action"); login.append(node("h4", "", uiMessages.users.grantLogin), input(uiMessages.users.email, "email", "", "email"), input(uiMessages.users.reason, "reason", ""), node("button", "btn btn-outline-secondary", uiMessages.users.createLogin));
        login.addEventListener("submit", async (event) => { event.preventDefault(); if (!confirm(uiMessages.users.confirmLogin)) return;
          const result = await mutation(`/api/admin/users/${id}/login`, "POST", { email: login.elements.email.value, reason: login.elements.reason.value });
          await showTemporary(result.data.temporary_password); await openDetail(id); await loadUsers(); }); body.append(login);
      }

      const authority = node("form", "user-action"); authority.append(node("h4", "", uiMessages.users.authority), input(uiMessages.users.reason, "reason", ""), node("button", user.system_admin ? "btn btn-outline-danger" : "btn btn-outline-secondary", user.system_admin ? uiMessages.users.revokeAuthority : uiMessages.users.grantAuthority));
      authority.addEventListener("submit", async (event) => { event.preventDefault(); if (!confirm(uiFormatters.authorityConfirmation(user.system_admin))) return;
        await mutation(`/api/admin/users/${id}/system-admin`, user.system_admin ? "DELETE" : "POST", { reason: authority.elements.reason.value, ...(user.system_admin ? { confirm: true } : {}) });
        await openDetail(id); await Promise.all([loadUsers(), loadSummary()]); }); body.append(authority);
    } catch (error) { body.textContent = errorMessage(error); }
  }

  async function loadSummary() {
    const payload = await api("/api/admin/users/authority-summary"); state.summary = payload.data;
    $("#users-summary").textContent = uiFormatters.authoritySummary(payload.data.effective_system_admins, payload.data.you_are_last);
  }

  $("#users-filter").addEventListener("submit", (event) => { event.preventDefault(); void loadUsers(); });
  $("#users-more").addEventListener("click", () => void loadUsers({ append: true }));
  $("#user-rows").addEventListener("click", (event) => { const button = event.target.closest("button[data-user-id]"); if (button) void openDetail(button.dataset.userId); });
  $("#close-user-detail").addEventListener("click", () => { $("#user-detail").hidden = true; state.selected = null; });
  bindResettableDialog($("#create-user-dialog"), $("#create-user-form"), $("#create-user-error"));
  $("#create-user").addEventListener("click", () => $("#create-user-dialog").showModal());
  $("#create-user-form").addEventListener("submit", async (event) => {
    event.preventDefault(); const form = event.currentTarget; const error = $("#create-user-error"); error.hidden = true;
    const submit = $("#create-user-submit"); if (submit.disabled) return;
    submit.disabled = true; setDialogBusy($("#create-user-dialog"), true);
    try {
      const result = await createAdministrator(api, { display_name: form.elements.display_name.value,
        email: form.elements.email.value, division_id: Number(form.elements.division_id.value), role_id: Number(form.elements.role_id.value),
        grant_system_admin: form.elements.grant_system_admin.checked, reason: form.elements.reason.value });
      $("#create-user-dialog").close(); await showTemporary(result.data.temporary_password); await Promise.all([loadUsers(), loadSummary()]);
    } catch (caught) { error.textContent = errorMessage(caught); error.hidden = false; }
    finally { submit.disabled = false; setDialogBusy($("#create-user-dialog"), false); }
  });
  $("#temporary-password-saved").addEventListener("change", (event) => { $("#close-temporary-password").disabled = !event.target.checked; });
  $("#temporary-password-dialog").addEventListener("close", () => { $("#temporary-password").textContent = ""; $("#temporary-password-saved").checked = false; });
  $("#temporary-password-dialog").addEventListener("cancel", (event) => event.preventDefault());

  return { async load() { if (!state.catalogs.divisions.length) await loadContext(); await loadUsers(); }, onSessionRequired };
}
