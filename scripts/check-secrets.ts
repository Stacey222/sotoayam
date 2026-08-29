import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

interface Finding {
  file: string;
  rule: string;
}

const SECRET_PATTERNS: Array<{ rule: string; pattern: RegExp }> = [
  { rule: "SUPABASE_SECRET_KEY", pattern: /sb_secret_[A-Za-z0-9_-]{20,}/ },
  { rule: "JWT_CREDENTIAL", pattern: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/ },
  { rule: "TELEGRAM_BOT_TOKEN", pattern: /\b\d{6,}:[A-Za-z0-9_-]{25,}\b/ },
  { rule: "PRIVATE_KEY", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  {
    rule: "ASSIGNED_SECRET",
    pattern: /^(?:SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SERVICE_KEY|TELEGRAM_BOT_TOKEN|INTERNAL_API_KEY|ADMIN_API_KEY)[ \t]*=[ \t]*[^\s#]+/m,
  },
];

async function main(): Promise<void> {
  const root = process.cwd();
  const trackedOutput = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
  const tracked = trackedOutput.split("\0").filter(Boolean);
  const findings: Finding[] = [];

  for (const file of tracked) {
    const normalized = file.replaceAll("\\", "/");
    const base = path.posix.basename(normalized);
    if ((base === ".env" || (base.startsWith(".env.") && base !== ".env.example")) || /\.(?:pem|p12|pfx)$/i.test(base)) {
      findings.push({ file: normalized, rule: "SECRET_BEARING_FILENAME" });
      continue;
    }
    let content: string;
    try {
      content = await readFile(path.resolve(root, file), "utf8");
    } catch {
      continue;
    }
    if (content.includes("\0")) continue;
    for (const { rule, pattern } of SECRET_PATTERNS) {
      if (pattern.test(content)) findings.push({ file: normalized, rule });
    }
  }

  if (findings.length === 0) {
    console.log("SECRET_SCAN = PASS");
    return;
  }

  console.log("SECRET_SCAN = FAIL");
  for (const finding of findings) console.log(`finding: ${finding.file} (${finding.rule})`);
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.log("SECRET_SCAN = FAIL");
  console.log(`error_type: ${error instanceof Error ? error.name : "UnknownError"}`);
  process.exitCode = 1;
});
