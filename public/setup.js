const form = document.querySelector("#setup-form");
const loading = document.querySelector("#setup-loading");
const notice = document.querySelector("#setup-notice");
const submit = document.querySelector("#setup-submit");
let csrfCookieName = "";

function cookie(name) {
  for (const pair of document.cookie.split(";").map((item) => item.trim())) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    if (decodeURIComponent(pair.slice(0, separator)) === name) return decodeURIComponent(pair.slice(separator + 1));
  }
  return "";
}

function showError(message) {
  notice.textContent = message;
  notice.hidden = false;
}

async function request(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", ...options,
    headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}) } });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message || "Permintaan tidak dapat diproses");
  return payload;
}

async function initialize() {
  try {
    const payload = await request("/api/setup/status");
    if (!payload.data.required) {
      location.replace("/");
      return;
    }
    csrfCookieName = payload.data.csrf_cookie_name;
    form.elements.business_time_zone.value = payload.data.default_business_time_zone;
    loading.hidden = true;
    form.hidden = false;
    form.elements.display_name.focus();
  } catch (error) {
    loading.textContent = error.message || "Status penyiapan tidak tersedia";
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (submit.disabled) return;
  notice.hidden = true;
  if (!form.reportValidity()) return;
  submit.disabled = true;
  submit.textContent = "Menyiapkan Sotoayam…";
  const values = new FormData(form);
  try {
    await request("/api/setup", { method: "POST", headers: { "X-CSRF-Token": cookie(csrfCookieName) },
      body: JSON.stringify({
        display_name: values.get("display_name"), email: values.get("email"),
        password: values.get("password"), password_confirmation: values.get("password_confirmation"),
        division_name: values.get("division_name"), business_time_zone: values.get("business_time_zone"),
      }) });
    location.replace("/?setup=complete");
  } catch (error) {
    showError(error.message || "Penyiapan gagal");
    submit.disabled = false;
    submit.textContent = "Selesaikan Penyiapan";
  }
});

void initialize();
