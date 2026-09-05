import { spawnSync } from "node:child_process";

interface CheckResult {
  name: string;
  passed: boolean;
}

function run(command: string, args: string[]): boolean {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: "inherit",
  });
  return result.status === 0;
}

function sourceControlReady(): boolean {
  const head = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: "ignore",
  });
  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const envTracked = spawnSync("git", ["ls-files", "--error-unmatch", ".env"], {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: "ignore",
  });
  return head.status === 0 && status.status === 0 && status.stdout.trim() === "" && envTracked.status !== 0;
}

function main(): void {
  console.log("Sotoayam Migration Baseline\n");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const checks: CheckResult[] = [
    { name: "SOURCE_CONTROL", passed: sourceControlReady() },
    { name: "TYPECHECK", passed: run(npm, ["run", "typecheck"]) },
    { name: "LEGACY_CONTRACT", passed: run(npm, ["run", "test:contract"]) },
    { name: "SCHEMA_COMPATIBILITY", passed: run(npm, ["run", "check:schema"]) },
    { name: "GOVERNANCE_FOUNDATION", passed: run(npm, ["run", "check:governance-schema"]) },
    { name: "IDENTITY_FOUNDATION", passed: run(npm, ["run", "check:identity-schema"]) },
    { name: "INGESTION_FOUNDATION", passed: run(npm, ["run", "check:ingestion-schema"]) },
    { name: "NOTIFICATION_FOUNDATION", passed: run(npm, ["run", "check:notification-schema"]) },
    { name: "REPORTING_FOUNDATION", passed: run(npm, ["run", "check:reporting-schema"]) },
    { name: "CRITICAL_ALERT_FOUNDATION", passed: run(npm, ["run", "check:critical-alert-schema"]) },
    { name: "GO_LIVE_STAGE2_FOUNDATION", passed: run(npm, ["run", "check:go-live-stage2-schema"]) },
    { name: "SUPABASE_CONNECTION", passed: run(npm, ["run", "check:supabase"]) },
    { name: "RECONCILIATION_HARNESS", passed: run(npm, ["run", "check:reconciliation"]) },
    { name: "SECRET_SCAN", passed: run(npm, ["run", "check:secrets"]) },
  ];

  console.log("\nSotoayam Migration Baseline Summary\n");
  for (const check of checks) console.log(`${check.name} = ${check.passed ? "PASS" : "FAIL"}`);
  const supabasePassed = checks.find((check) => check.name === "SUPABASE_CONNECTION")?.passed === true;
  console.log(`REVERSIBLE_WRITE = ${supabasePassed ? "PASS" : "FAIL"}`);
  const passed = checks.every((check) => check.passed);
  console.log(`\nRESULT = ${passed ? "PASS" : "FAIL"}`);
  if (!passed) process.exitCode = 1;
}

main();
