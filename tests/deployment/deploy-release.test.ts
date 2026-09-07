import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const deployScript = path.join(projectRoot, "scripts/deploy/deploy-release.sh");
const bashCommand = process.platform === "win32"
  ? path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git/bin/bash.exe")
  : "bash";
const temporaryDirectories: string[] = [];

function bashPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_match, drive: string) => `/${drive.toLowerCase()}`);
}

async function executable(file: string, contents: string): Promise<void> {
  await writeFile(file, contents, "utf8");
  await chmod(file, 0o755);
}

interface DeploymentFixture {
  appRoot: string;
  archive: string;
  log: string;
  oldRelease: string;
  run(overrides?: NodeJS.ProcessEnv): SpawnSyncReturns<string>;
}

async function deploymentFixture(existingRelease = true): Promise<DeploymentFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sotoayam-deploy-"));
  temporaryDirectories.push(root);
  const appRoot = path.join(root, "app");
  const oldRelease = path.join(appRoot, "releases", "release-1111111-20260907000000");
  const payload = path.join(root, "payload");
  const fakeBin = path.join(root, "bin");
  const log = path.join(root, "commands.log");
  const fakeSupabase = path.join(root, "fake-supabase");
  const archive = path.join(root, "release.tar.gz");

  await mkdir(path.join(appRoot, "shared"), { recursive: true });
  await mkdir(oldRelease, { recursive: true });
  if (existingRelease) await symlink(oldRelease, path.join(appRoot, "current"), "junction");
  await mkdir(path.join(payload, "scripts"), { recursive: true });
  await mkdir(path.join(payload, "supabase", "migrations"), { recursive: true });
  await mkdir(path.join(payload, "dist", "src"), { recursive: true });
  await mkdir(path.join(payload, "public"), { recursive: true });
  await writeFile(path.join(payload, "package.json"), "{}\n", "utf8");
  await writeFile(path.join(payload, "package-lock.json"), "{}\n", "utf8");
  await writeFile(path.join(payload, ".node-version"), "24.20.0\n", "utf8");
  await writeFile(path.join(payload, "scripts", "migrate.ts"), "// test fixture\n", "utf8");
  await writeFile(path.join(payload, "supabase", "config.toml"), 'project_id = "test"\n', "utf8");
  await writeFile(path.join(payload, "supabase", "migrations", "202609070001_test.sql"), "select 1;\n", "utf8");
  await mkdir(fakeBin, { recursive: true });
  await executable(path.join(fakeBin, "node"), `#!/usr/bin/env bash
printf 'v%s\\n' "\${DEPLOY_TEST_NODE_VERSION:-24.20.0}"
`);

  await executable(fakeSupabase, `#!/usr/bin/env bash
printf 'supabase %s\\n' "$*" >>"$DEPLOY_TEST_LOG"
exit "\${DEPLOY_TEST_LINK_EXIT:-0}"
`);
  await executable(path.join(fakeBin, "npm"), `#!/usr/bin/env bash
printf 'npm %s\\n' "$*" >>"$DEPLOY_TEST_LOG"
if [[ "$1" == "ci" ]]; then
  [[ "\${DEPLOY_TEST_INSTALL_EXIT:-0}" == "0" ]] || exit "$DEPLOY_TEST_INSTALL_EXIT"
  mkdir -p node_modules/.bin
  if [[ "\${DEPLOY_TEST_SKIP_CLI:-0}" != "1" ]]; then
    cp "$DEPLOY_TEST_FAKE_SUPABASE" node_modules/.bin/supabase
    chmod +x node_modules/.bin/supabase
  fi
elif [[ "$1 $2" == "run migrate" ]]; then
  exit "\${DEPLOY_TEST_MIGRATION_EXIT:-0}"
fi
`);
  await executable(path.join(fakeBin, "sudo"), `#!/usr/bin/env bash
printf 'sudo %s\\n' "$*" >>"$DEPLOY_TEST_LOG"
exit "\${DEPLOY_TEST_RESTART_EXIT:-0}"
`);
  const fakeCurl = `#!/usr/bin/env bash
printf 'curl %s\\n' "$*" >>"$DEPLOY_TEST_LOG"
exit "\${DEPLOY_TEST_HEALTH_EXIT:-0}"
`;
  await executable(path.join(fakeBin, "curl"), fakeCurl);
  if (process.platform === "win32") await executable(path.join(fakeBin, "curl.exe"), fakeCurl);

  const tar = spawnSync("tar", ["-czf", archive, "-C", payload, "."], { encoding: "utf8" });
  if (tar.status !== 0) throw new Error(`Unable to create deployment fixture: ${tar.stderr}`);

  return {
    appRoot,
    archive,
    log,
    oldRelease,
    run(overrides = {}) {
      return spawnSync(bashCommand, [bashPath(deployScript), bashPath(archive), "release-abcdef0-20260907010101"], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bashPath(fakeBin)}:/usr/bin:/bin`,
          NODE_ENV: "test",
          SOTOAYAM_DEPLOY_TEST_ROOT: bashPath(appRoot),
          SOTOAYAM_DEPLOY_TEST_CURL: bashPath(path.join(fakeBin, "curl")),
          SUPABASE_ACCESS_TOKEN: "test-access-token",
          SUPABASE_DB_PASSWORD: "test-database-password",
          SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst",
          DEPLOY_TEST_LOG: bashPath(log),
          DEPLOY_TEST_FAKE_SUPABASE: bashPath(fakeSupabase),
          ...overrides,
        },
      });
    },
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("release deployment migration gate", () => {
  it("activates and restarts only after one successful migration", async () => {
    const fixture = await deploymentFixture(false);
    const result = fixture.run();
    const commands = await readFile(fixture.log, "utf8");

    expect(result.status, result.stderr).toBe(0);
    expect(commands.match(/npm run migrate/g)).toHaveLength(1);
    expect(commands.indexOf("npm ci --include=dev --ignore-scripts")).toBeLessThan(commands.indexOf("supabase link"));
    expect(commands.indexOf("supabase link")).toBeLessThan(commands.indexOf("npm run migrate"));
    expect(commands.indexOf("npm run migrate")).toBeLessThan(commands.indexOf("npm prune --omit=dev --ignore-scripts"));
    expect(commands.indexOf("npm prune --omit=dev --ignore-scripts")).toBeLessThan(commands.indexOf("sudo systemctl restart"));
    expect(commands.indexOf("sudo systemctl restart")).toBeLessThan(commands.indexOf("curl -fsS"));
    await expect(readFile(path.join(fixture.appRoot, "current", "package.json"), "utf8")).resolves.toBe("{}\n");
  });

  it.each([
    ["install failure", { DEPLOY_TEST_INSTALL_EXIT: "2" }, 0],
    ["migration failure", { DEPLOY_TEST_MIGRATION_EXIT: "3" }, 1],
    ["Supabase CLI unavailable", { DEPLOY_TEST_SKIP_CLI: "1" }, 0],
    ["Supabase authentication or link failure", { DEPLOY_TEST_LINK_EXIT: "4" }, 0],
    ["unsupported Node.js runtime", { DEPLOY_TEST_NODE_VERSION: "22.14.0" }, 0],
  ])("keeps the existing release and does not restart after %s", async (_label, overrides, migrationRuns) => {
    const fixture = await deploymentFixture();
    const result = fixture.run(overrides);
    const commands = await readFile(fixture.log, "utf8").catch(() => "");

    expect(result.status).not.toBe(0);
    expect(commands).not.toContain("sudo systemctl restart");
    expect(commands.match(/npm run migrate/g) ?? []).toHaveLength(migrationRuns);
    expect(await realpath(path.join(fixture.appRoot, "current"))).toBe(await realpath(fixture.oldRelease));
  });

  it("fails before preparation when deployment authentication is missing", async () => {
    const fixture = await deploymentFixture();
    const result = fixture.run({ SUPABASE_ACCESS_TOKEN: "" });

    expect(result.status).not.toBe(0);
    await expect(readFile(fixture.log, "utf8")).rejects.toThrow();
    expect(result.stderr ?? "").toContain("SUPABASE_ACCESS_TOKEN");
  });

  it("reports post-activation health failure without attempting database rollback", async () => {
    const fixture = await deploymentFixture(false);
    const result = fixture.run({ DEPLOY_TEST_HEALTH_EXIT: "5" });
    const commands = await readFile(fixture.log, "utf8");

    expect(result.status).not.toBe(0);
    expect(commands).toContain("npm run migrate");
    expect(commands).toContain("sudo systemctl restart sotoayam.service");
    expect(result.stderr).toContain("POST_ACTIVATION_HEALTH=FAIL");
    expect(commands).not.toMatch(/rollback|db reset|migration down/);
  });
});

describe("release packaging", () => {
  it("includes the official migration runner, config, and migration inventory", async () => {
    const packaging = await readFile(path.join(projectRoot, "scripts/deploy/package-release.ps1"), "utf8");
    expect(packaging).toContain(".node-version scripts/migrate.ts scripts/deploy/deployment-config.sh supabase/config.toml supabase/migrations");
    expect(packaging.indexOf("npm run build")).toBeLessThan(packaging.indexOf("tar -czf"));
  });
});
