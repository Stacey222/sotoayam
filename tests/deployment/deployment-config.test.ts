import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const configScript = path.join(projectRoot, "scripts/deploy/deployment-config.sh");
const bootstrapScript = path.join(projectRoot, "scripts/deploy/bootstrap-vps.sh");
const bashCommand = process.platform === "win32"
  ? path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git/bin/bash.exe")
  : "bash";
const temporaryDirectories: string[] = [];

function bashPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_match, drive: string) => `/${drive.toLowerCase()}`);
}

function runConfig(command: string, environment: NodeJS.ProcessEnv = {}) {
  return spawnSync(bashCommand, ["-c", `source "$1"; ${command}`, "_", bashPath(configScript)], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", ...environment },
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("fresh-install deployment configuration", () => {
  it("resolves predictable Sotoayam defaults without a founder account", () => {
    const result = runConfig(
      'load_deployment_config; DEPLOY_USER=operator; require_deploy_user; printf "%s|%s|%s|%s|%s|%s\\n" "$DEPLOY_USER" "$APP_ROOT" "$APP_USER" "$APP_GROUP" "$SERVICE_NAME" "$HEALTH_PORT"',
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("operator|/opt/sotoayam|sotoayam|sotoayam|sotoayam.service|3000");
  });

  it("honors explicit deployment identity, root, service identity, and service name", () => {
    const result = runConfig(
      'load_deployment_config; require_deploy_user; render_systemd_unit; render_deploy_sudoers',
      {
        DEPLOY_USER: "customerops",
        APP_ROOT: "/srv/customer/sotoayam",
        APP_USER: "sotoapp",
        APP_GROUP: "sotoapp",
        SERVICE_NAME: "customer-sotoayam.service",
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("User=sotoapp");
    expect(result.stdout).toContain("Group=sotoapp");
    expect(result.stdout).toContain("WorkingDirectory=/srv/customer/sotoayam/current");
    expect(result.stdout).toContain("EnvironmentFile=/srv/customer/sotoayam/shared/.env");
    expect(result.stdout).toContain("customerops ALL=(root) NOPASSWD:");
    expect(result.stdout).toContain("systemctl restart customer-sotoayam.service");
  });

  it.each(["", "/", "relative/path", "/opt/../etc", "/opt/path with spaces", "/opt/sotoayam/"])(
    "rejects unsafe APP_ROOT value %j",
    (appRoot) => {
      const result = runConfig("load_deployment_config", { APP_ROOT: appRoot });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("APP_ROOT");
    },
  );

  it("requires an explicit non-root deployment user", () => {
    const missing = runConfig("load_deployment_config; require_deploy_user");
    const root = runConfig("load_deployment_config; require_deploy_user", { DEPLOY_USER: "root" });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("DEPLOY_USER is required");
    expect(root.status).not.toBe(0);
    expect(root.stderr).toContain("non-root");
  });

  it.each(["0", "65536", "not-a-port"])("rejects unsafe HEALTH_PORT value %j", (healthPort) => {
    const result = runConfig("load_deployment_config", { HEALTH_PORT: healthPort });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("HEALTH_PORT");
  });

  it("retains compatibility-sensitive legacy installation values when explicitly supplied", () => {
    const result = runConfig(
      'load_deployment_config; printf "%s|%s|%s|%s\\n" "$APP_ROOT" "$APP_USER" "$APP_GROUP" "$SERVICE_NAME"',
      {
        APP_ROOT: "/opt/gwens-automation",
        APP_USER: "gwens",
        APP_GROUP: "gwens",
        SERVICE_NAME: "gwens-automation.service",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("/opt/gwens-automation|gwens|gwens|gwens-automation.service");
  });

  it("contains no founder-specific deployment username", async () => {
    await expect(readFile(bootstrapScript, "utf8")).resolves.not.toContain("karburontok3");
  });
});

describe("Node.js deployment policy", () => {
  async function nodeFixture(version: string) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sotoayam-node-policy-"));
    temporaryDirectories.push(directory);
    const node = path.join(directory, "node");
    await writeFile(node, `#!/usr/bin/env bash\nprintf 'v${version}\\n'\n`, "utf8");
    await chmod(node, 0o755);
    const pin = path.join(directory, ".node-version");
    await writeFile(pin, "24.20.0\n", "utf8");
    return { directory, pin };
  }

  it("accepts the exact supported Node.js version", async () => {
    const fixture = await nodeFixture("24.20.0");
    const verified = spawnSync(bashCommand, ["-c", 'source "$1"; require_supported_node "$2"', "_", bashPath(configScript), bashPath(fixture.pin)], {
      encoding: "utf8",
      env: { PATH: `${bashPath(fixture.directory)}:/usr/bin:/bin` },
    });
    expect(verified.status, verified.stderr).toBe(0);
  });

  it("rejects an unsupported Node.js version clearly", async () => {
    const fixture = await nodeFixture("22.14.0");
    const result = spawnSync(bashCommand, ["-c", 'source "$1"; require_supported_node "$2"', "_", bashPath(configScript), bashPath(fixture.pin)], {
      encoding: "utf8",
      env: { PATH: `${bashPath(fixture.directory)}:/usr/bin:/bin` },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unsupported Node.js version v22.14.0; required v24.20.0");
  });

  it("keeps package engine metadata synchronized with the authoritative pin", async () => {
    const pin = (await readFile(path.join(projectRoot, ".node-version"), "utf8")).trim();
    const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8")) as {
      engines: { node: string };
    };
    expect(pin).toBe("24.20.0");
    expect(packageJson.engines.node).toBe(pin);
  });
});
