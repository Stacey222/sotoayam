import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import path from "node:path";
import { readFile } from "node:fs/promises";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function unusedPort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function fakeSupabase() {
  return createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    response.setHeader("content-type", "application/json");
    response.setHeader("content-range", "*/0");
    if (pathname === "/rest/v1/rpc/get_instance_settings") {
      response.end(JSON.stringify({ business_time_zone: null, reminder_scheduler_interval_seconds: null,
        critical_alert_policy: null, business_actor_user_id: null, business_actor_display_name: null,
        business_actor_eligible: false, version: 0, updated_at: null }));
      return;
    }
    if (pathname === "/rest/v1/rpc/load_telegram_polling_state") {
      response.end("0");
      return;
    }
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    response.end("[]");
  });
}

async function waitFor(url, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Production process exited during startup with code ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.status === 200) return response;
    } catch { /* bounded startup wait */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Production process did not become available: ${new URL(url).pathname}`);
}

async function main() {
  const root = path.resolve(import.meta.dirname, "../..");
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (manifest.scripts?.start !== "node dist/src/server.js" || /tsx|watch/i.test(manifest.scripts.start)) {
    throw new Error("Production start contract must execute built code without a watcher");
  }

  const supabase = fakeSupabase();
  const supabasePort = await listen(supabase);
  const appPort = await unusedPort();
  const child = spawn(process.execPath, ["dist/src/server.js"], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "production",
      SUPABASE_URL: `http://127.0.0.1:${supabasePort}`,
      SUPABASE_SERVICE_ROLE_KEY: "x.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.x",
      TELEGRAM_BOT_TOKEN: "production-smoke-token",
      INTERNAL_API_KEY: "production-smoke-internal-key",
      INTERNAL_API_KEY_FALLBACK_ENABLED: "false",
      ADMIN_API_KEY_FALLBACK_ENABLED: "false",
      SESSION_COOKIE_SECURE: "true",
      TRUST_PROXY: "true",
      HOST: "127.0.0.1",
      PORT: String(appPort),
      TELEGRAM_POLLING_ENABLED: "false",
      REMINDER_SCHEDULER_ENABLED: "false",
      CRITICAL_ALERT_EVALUATOR_ENABLED: "false",
      BUSINESS_TIME_ZONE: "UTC",
      NOTIFICATION_PREFERENCE_RESOLVER_MODE: "NORMALIZED",
      LOG_LEVEL: "silent",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });

  try {
    const base = `http://127.0.0.1:${appPort}`;
    const health = await waitFor(`${base}/health`, child);
    const ready = await fetch(`${base}/ready`);
    const readyBody = await ready.json();
    const rootPage = await fetch(`${base}/`);
    const setupPage = await fetch(`${base}/setup`, { redirect: "manual" });
    if (health.status !== 200) throw new Error("Liveness failed");
    if (ready.status !== 200 || readyBody.ready !== true || readyBody.status !== "READY") {
      throw new Error("Readiness failed");
    }
    if (rootPage.status !== 200 || !(await rootPage.text()).includes("Sotoayam")) throw new Error("Static UI failed");
    if (setupPage.status !== 200 || !(await setupPage.text()).includes("Sotoayam")) throw new Error("Fresh setup page failed");
    process.stdout.write("PRODUCTION_START=PASS\nHEALTH=200\nREADINESS=200 READY\nSTATIC_UI=200\nFRESH_SETUP=200\n");
  } finally {
    child.kill("SIGTERM");
    const closed = Promise.race([
      once(child, "close"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Production process did not stop after SIGTERM")), 5_000)),
    ]);
    await closed.catch((error) => { child.kill("SIGKILL"); throw error; });
    await new Promise((resolve, reject) => supabase.close((error) => error ? reject(error) : resolve()));
  }
  if (stderr) throw new Error("Production process wrote to stderr during smoke test");
  process.stdout.write("GRACEFUL_SHUTDOWN=PASS\nNO_DEV_WATCHER=PASS\n");
}

main().catch((error) => {
  process.stderr.write(`PRODUCTION_SMOKE=FAIL reason=${error instanceof Error ? error.message : "unknown"}\n`);
  process.exitCode = 1;
});
