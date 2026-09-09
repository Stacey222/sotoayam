const rows = document.querySelector("#user-rows");
const empty = document.querySelector("#empty");
const notice = document.querySelector("#notice");
const editor = document.querySelector("#editor");
const form = document.querySelector("#edit-form");
const loginDialog = document.querySelector("#login-dialog");
const loginForm = document.querySelector("#login-form");
const loginError = document.querySelector("#login-error");
const logoutButton = document.querySelector("#logout");
let selectedStatus = "pending";
let usersById = new Map();
let catalogs = { divisions: [], roles: [] };

function csrfToken() {
  const cookies = Object.fromEntries(document.cookie.split(";").map((item) => item.trim().split("=").map(decodeURIComponent)));
  return cookies["__Host-sotoayam_csrf"] || cookies.sotoayam_csrf || "";
}
function showNotice(message) { notice.textContent = message; notice.hidden = !message; }
async function api(path, options = {}) {
  const method = options.method || "GET";
  const csrf = ["POST", "PUT", "PATCH", "DELETE"].includes(method) ? csrfToken() : "";
  const response = await fetch(path, { ...options, credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(csrf ? { "X-CSRF-Token": csrf } : {}), ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(payload.error?.message || "Permintaan gagal"); error.status = response.status; throw error; }
  return payload;
}
function statusFor(user) {
  if (user.active) return ["Active", "active"];
  if (!user.division || !user.role) return ["Pending", "pending"];
  return ["Inactive", "inactive"];
}
function cell(text) { const element = document.createElement("td"); element.textContent = text; return element; }
function render(users) {
  rows.replaceChildren(); usersById = new Map(users.map((user) => [String(user.id), user]));
  for (const user of users) {
    const row = document.createElement("tr");
    row.append(cell(user.display_name || "-"), cell(user.telegram_connected ? "Yes" : "No"), cell(user.division?.name || "-"), cell(user.role?.name || "-"));
    const statusCell = document.createElement("td"); const [label, className] = statusFor(user);
    const badge = document.createElement("span"); badge.className = `badge ${className}`; badge.textContent = label; statusCell.append(badge); row.append(statusCell);
    const actionCell = document.createElement("td"); const edit = document.createElement("button"); edit.type = "button"; edit.textContent = "Edit Access"; edit.dataset.userId = String(user.id); actionCell.append(edit); row.append(actionCell); rows.append(row);
  }
  empty.hidden = users.length !== 0;
}
function setOptions(select, values, current, emptyLabel) {
  const emptyOption = document.createElement("option"); emptyOption.value = ""; emptyOption.textContent = emptyLabel;
  const options = values.map((value) => { const option = document.createElement("option"); option.value = String(value.id); option.textContent = value.name; return option; });
  if (current && !values.some((value) => value.id === current.id)) {
    const retained = document.createElement("option"); retained.value = String(current.id); retained.textContent = `${current.name} (disabled, retained)`; retained.disabled = true; retained.selected = true; options.push(retained);
  }
  select.replaceChildren(emptyOption, ...options); select.value = current ? String(current.id) : "";
}
async function loadUsers() {
  showNotice(""); rows.setAttribute("aria-busy", "true");
  try {
    const [catalogPayload, userPayload] = await Promise.all([api("/api/admin/users/catalogs"), api(`/api/admin/users?status=${encodeURIComponent(selectedStatus)}`)]);
    catalogs = catalogPayload.data; render(userPayload.data);
  } catch (error) { if (error.status === 401) loginDialog.showModal(); else showNotice(error.message); render([]); }
  finally { rows.removeAttribute("aria-busy"); }
}
function openEditor(user) {
  document.querySelector("#user-id").value = user.id; document.querySelector("#display-name").value = user.display_name || "-";
  document.querySelector("#telegram-connected").value = user.telegram_connected ? "Yes" : "No";
  setOptions(document.querySelector("#division"), catalogs.divisions, user.division, "Belum ditetapkan");
  setOptions(document.querySelector("#role"), catalogs.roles, user.role, "Belum ditetapkan");
  document.querySelector("#active").checked = user.active; editor.showModal();
}
document.querySelectorAll(".filter").forEach((button) => button.addEventListener("click", () => { selectedStatus = button.dataset.status; document.querySelectorAll(".filter").forEach((item) => item.classList.toggle("active", item === button)); void loadUsers(); }));
document.querySelector("#refresh").addEventListener("click", () => void loadUsers());
loginForm.addEventListener("submit", async (event) => {
  event.preventDefault(); loginError.hidden = true;
  try {
    await api("/api/admin/auth/login", { method: "POST", body: JSON.stringify({
      email: document.querySelector("#login-email").value,
      password: document.querySelector("#login-password").value,
    }) });
    document.querySelector("#login-password").value = ""; loginDialog.close(); logoutButton.hidden = false; await loadUsers();
  } catch (error) { loginError.textContent = error.message; loginError.hidden = false; }
});
logoutButton.addEventListener("click", async () => { try { await api("/api/admin/auth/logout", { method: "POST" }); } finally { logoutButton.hidden = true; loginDialog.showModal(); render([]); } });
rows.addEventListener("click", (event) => { const button = event.target.closest("button[data-user-id]"); const user = button ? usersById.get(button.dataset.userId) : null; if (user) openEditor(user); });
document.querySelector("#close-dialog").addEventListener("click", () => editor.close());
document.querySelector("#cancel").addEventListener("click", () => editor.close());
form.addEventListener("submit", async (event) => {
  event.preventDefault(); const division = document.querySelector("#division").value; const role = document.querySelector("#role").value;
  const body = { division_id: division ? Number(division) : null, role_id: role ? Number(role) : null, active: document.querySelector("#active").checked };
  try { await api(`/api/admin/users/${document.querySelector("#user-id").value}/access`, { method: "PATCH", body: JSON.stringify(body) }); editor.close(); await loadUsers(); }
  catch (error) { window.alert(error.message); }
});
void api("/api/admin/auth/session").then(() => { logoutButton.hidden = false; return loadUsers(); }).catch(() => loginDialog.showModal());
