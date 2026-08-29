const divisions = ["Purchasing", "Sales Grosir", "Digital Marketing", "Content Creator", "On Page / B2C", "Live Shopee", "Gudang", "Management"];
const roles = ["Staff", "Admin", "PIC", "Supervisor", "Manager", "Owner"];
const preferences = {
  stock_alert: "Stock Alert",
  purchase_alert: "Purchase Alert",
  sales_alert: "Sales Alert",
  marketing_alert: "Marketing Alert",
  content_alert: "Content Alert",
  owner_report: "Owner Report",
  system_error: "System Error",
};

const rows = document.querySelector("#user-rows");
const empty = document.querySelector("#empty");
const notice = document.querySelector("#notice");
const editor = document.querySelector("#editor");
const form = document.querySelector("#edit-form");
let selectedStatus = "all";
let usersById = new Map();

function adminHeaders() {
  const key = sessionStorage.getItem("gwens-admin-key");
  return key ? { "X-Admin-Api-Key": key } : {};
}

function showNotice(message) {
  notice.textContent = message;
  notice.hidden = !message;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...adminHeaders(), ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error?.message || "Permintaan gagal");
  return payload;
}

function statusFor(user) {
  if (user.active) return ["Active", "active"];
  if (user.division === "UNASSIGNED") return ["Pending", "pending"];
  return ["Inactive", "inactive"];
}

function cell(text) {
  const element = document.createElement("td");
  element.textContent = text;
  return element;
}

function render(users) {
  rows.replaceChildren();
  usersById = new Map(users.map((user) => [String(user.id), user]));
  for (const user of users) {
    const row = document.createElement("tr");
    row.append(cell(user.name || user.telegram_first_name || "-"));
    row.append(cell(user.telegram_username ? `@${user.telegram_username}` : String(user.telegram_chat_id)));
    row.append(cell(user.division));
    row.append(cell(user.role === "UNASSIGNED" ? "-" : user.role));
    const statusCell = document.createElement("td");
    const [label, className] = statusFor(user);
    const badge = document.createElement("span");
    badge.className = `badge ${className}`;
    badge.textContent = label;
    statusCell.append(badge);
    row.append(statusCell);
    const actionCell = document.createElement("td");
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "Edit";
    edit.dataset.userId = String(user.id);
    actionCell.append(edit);
    row.append(actionCell);
    rows.append(row);
  }
  empty.hidden = users.length !== 0;
}

async function loadUsers() {
  showNotice("");
  rows.setAttribute("aria-busy", "true");
  try {
    const query = selectedStatus === "all" ? "" : `?status=${encodeURIComponent(selectedStatus)}`;
    const payload = await api(`/api/users${query}`);
    render(payload.data);
  } catch (error) {
    showNotice(`${error.message}. Jika proteksi admin aktif, masukkan Admin Key.`);
    render([]);
  } finally {
    rows.removeAttribute("aria-busy");
  }
}

function addOptions(select, values) {
  select.replaceChildren(...values.map((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    return option;
  }));
}

function openEditor(user) {
  document.querySelector("#user-id").value = user.id;
  document.querySelector("#telegram-user").value = user.telegram_username ? `@${user.telegram_username}` : String(user.telegram_chat_id);
  document.querySelector("#name").value = user.name || user.telegram_first_name || "";
  document.querySelector("#division").value = divisions.includes(user.division) ? user.division : divisions[0];
  document.querySelector("#role").value = roles.includes(user.role) ? user.role : roles[0];
  document.querySelector("#active").checked = user.active;
  for (const field of Object.keys(preferences)) document.querySelector(`#${field}`).checked = user[field];
  editor.showModal();
}

addOptions(document.querySelector("#division"), divisions);
addOptions(document.querySelector("#role"), roles);
const preferenceContainer = document.querySelector("#preferences");
for (const [field, label] of Object.entries(preferences)) {
  const wrapper = document.createElement("label");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.id = field;
  wrapper.append(checkbox, document.createTextNode(label));
  preferenceContainer.append(wrapper);
}

document.querySelectorAll(".filter").forEach((button) => button.addEventListener("click", () => {
  selectedStatus = button.dataset.status;
  document.querySelectorAll(".filter").forEach((item) => item.classList.toggle("active", item === button));
  void loadUsers();
}));
document.querySelector("#refresh").addEventListener("click", () => void loadUsers());
document.querySelector("#admin-key-button").addEventListener("click", () => {
  const key = window.prompt("Masukkan Admin API Key (kosongkan untuk menghapus):", "");
  if (key === null) return;
  if (key.trim()) sessionStorage.setItem("gwens-admin-key", key.trim());
  else sessionStorage.removeItem("gwens-admin-key");
  void loadUsers();
});
rows.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-user-id]");
  const user = button ? usersById.get(button.dataset.userId) : null;
  if (user) openEditor(user);
});
document.querySelector("#close-dialog").addEventListener("click", () => editor.close());
document.querySelector("#cancel").addEventListener("click", () => editor.close());
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = {
    name: document.querySelector("#name").value,
    division: document.querySelector("#division").value,
    role: document.querySelector("#role").value,
    active: document.querySelector("#active").checked,
  };
  for (const field of Object.keys(preferences)) body[field] = document.querySelector(`#${field}`).checked;
  try {
    await api(`/api/users/${document.querySelector("#user-id").value}`, { method: "PATCH", body: JSON.stringify(body) });
    editor.close();
    await loadUsers();
  } catch (error) {
    window.alert(error.message);
  }
});

void loadUsers();
