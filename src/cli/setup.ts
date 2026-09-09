import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { loadSupabaseConfig } from "../config/env.js";
import { createSupabaseClient } from "../db/supabase.js";
import {
  asFirstAdminBootstrapError,
  FirstAdminBootstrapError,
  SupabaseFirstAdminBootstrapRepository,
} from "../repositories/first-admin-bootstrap.repository.js";
import { FirstAdminBootstrapService, normalizeFirstAdminIdentity } from "../services/first-admin-bootstrap.service.js";

interface SetupArguments {
  name?: string;
  email?: string;
  passwordFile?: string;
  freshInstall?: boolean;
  keepExistingTaxonomy?: boolean;
  divisionName?: string;
  divisionCode?: string;
}

export interface SetupIo {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  env: NodeJS.ProcessEnv;
}

export interface SetupDependencies {
  createService(): FirstAdminBootstrapService;
  promptText(label: string): Promise<string>;
  promptSecret(label: string): Promise<Buffer>;
  readPasswordFile(path: string): Promise<Buffer>;
}

function parseArguments(argv: string[]): SetupArguments {
  const parsed: SetupArguments = {};
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!["--name", "--email", "--password-file", "--fresh-install", "--keep-existing-taxonomy", "--division-name", "--division-code"].includes(argument)) {
      throw new FirstAdminBootstrapError("BOOTSTRAP_INPUT_UNAVAILABLE", `Unsupported setup argument: ${argument}`);
    }
    if (seen.has(argument)) {
      throw new FirstAdminBootstrapError("BOOTSTRAP_INPUT_UNAVAILABLE", `Duplicate setup argument: ${argument}`);
    }
    seen.add(argument);
    if (argument === "--fresh-install" || argument === "--keep-existing-taxonomy") {
      if (argument === "--fresh-install") parsed.freshInstall = true;
      else parsed.keepExistingTaxonomy = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new FirstAdminBootstrapError("BOOTSTRAP_INPUT_UNAVAILABLE", `Missing value for ${argument}`);
    }
    if (argument === "--name") parsed.name = value;
    if (argument === "--email") parsed.email = value;
    if (argument === "--password-file") parsed.passwordFile = value;
    if (argument === "--division-name") parsed.divisionName = value;
    if (argument === "--division-code") parsed.divisionCode = value;
    index += 1;
  }
  return parsed;
}

function normalizeDivisionCode(value: string): string {
  const code = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(code)) {
    throw new FirstAdminBootstrapError("BOOTSTRAP_INPUT_UNAVAILABLE", "Division code must use uppercase letters, digits, and underscores");
  }
  return code;
}

function deriveDivisionCode(value: string): string {
  return normalizeDivisionCode(value.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, ""));
}

function assertFreshPreview(preview: Awaited<ReturnType<FirstAdminBootstrapService["preview"]>>): void {
  const evidence = preview.evidence;
  const evidenceVeto = ["users", "telegram_users", "tasks", "non_migration_seed_audit_logs"]
    .some((key) => (evidence[key] ?? 0) !== 0);
  if (evidenceVeto) {
    throw new FirstAdminBootstrapError("FRESH_INSTALL_EVIDENCE_VETO", "Existing installation evidence blocks fresh taxonomy retirement");
  }
  const zeroReferences = ["users_division_refs", "task_requesting_division_refs", "task_owner_division_refs",
    "integration_requesting_division_refs", "routing_owner_division_refs", "alert_owner_division_refs"]
    .every((key) => (evidence[key] ?? 0) === 0);
  const exactSeed = (evidence.extra_or_modified_seed_divisions ?? 0) === 0
    && (evidence.non_origin_collaboration_rules ?? 0) === 0
    && evidence.collaboration_source_division_refs === 1
    && evidence.collaboration_target_division_refs === 1
    && preview.retirement_divisions.length === 9
    && preview.retirement_rule !== null;
  if (!zeroReferences || !exactSeed) {
    throw new FirstAdminBootstrapError("FRESH_INSTALL_SEED_MISMATCH", "Origin taxonomy does not exactly match the safe retirement set");
  }
}

async function defaultPromptText(io: SetupIo, label: string): Promise<string> {
  if (!io.stdin.isTTY) {
    throw new FirstAdminBootstrapError("BOOTSTRAP_INPUT_UNAVAILABLE", `${label} requires an interactive terminal or a command flag`);
  }
  const readline = createInterface({ input: io.stdin, output: io.stdout });
  try {
    return await readline.question(`${label}: `);
  } finally {
    readline.close();
  }
}

async function defaultPromptSecret(io: SetupIo, label: string): Promise<Buffer> {
  if (!io.stdin.isTTY || typeof io.stdin.setRawMode !== "function") {
    throw new FirstAdminBootstrapError("BOOTSTRAP_INPUT_UNAVAILABLE", "A password source is required when stdin is not an interactive terminal");
  }
  io.stdout.write(`${label}: `);
  const bytes: number[] = [];
  const wasRaw = io.stdin.isRaw;
  io.stdin.setRawMode(true);
  io.stdin.resume();
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const onData = (chunk: Buffer | string) => {
        const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        for (const byte of input) {
          if (byte === 3) {
            cleanup();
            reject(new FirstAdminBootstrapError("BOOTSTRAP_INPUT_UNAVAILABLE", "Setup cancelled"));
            return;
          }
          if (byte === 13 || byte === 10) {
            cleanup();
            io.stdout.write("\n");
            resolve(Buffer.from(bytes));
            return;
          }
          if (byte === 8 || byte === 127) bytes.pop();
          else bytes.push(byte);
        }
      };
      const cleanup = () => io.stdin.off("data", onData);
      io.stdin.on("data", onData);
    });
  } finally {
    io.stdin.setRawMode(Boolean(wasRaw));
    io.stdin.pause();
  }
}

function trimTerminalNewline(buffer: Buffer): Buffer {
  let end = buffer.length;
  if (end > 0 && buffer[end - 1] === 10) end -= 1;
  if (end > 0 && buffer[end - 1] === 13) end -= 1;
  return buffer.subarray(0, end);
}

function defaultDependencies(io: SetupIo): SetupDependencies {
  return {
    createService() {
      try {
        const client = createSupabaseClient(loadSupabaseConfig());
        return new FirstAdminBootstrapService(new SupabaseFirstAdminBootstrapRepository(client));
      } catch {
        throw new FirstAdminBootstrapError(
          "MISSING_CONFIGURATION",
          "SUPABASE_URL and a valid service-role credential are required",
        );
      }
    },
    promptText: (label) => defaultPromptText(io, label),
    promptSecret: (label) => defaultPromptSecret(io, label),
    readPasswordFile: (path) => readFile(path),
  };
}

async function collectPassword(
  args: SetupArguments,
  io: SetupIo,
  dependencies: SetupDependencies,
): Promise<Buffer> {
  if (args.passwordFile) {
    try {
      return trimTerminalNewline(await dependencies.readPasswordFile(args.passwordFile));
    } catch {
      throw new FirstAdminBootstrapError("BOOTSTRAP_INPUT_UNAVAILABLE", "Unable to read the password file");
    }
  }
  if (io.env.SOTOAYAM_BOOTSTRAP_ADMIN_PASSWORD !== undefined) {
    return Buffer.from(io.env.SOTOAYAM_BOOTSTRAP_ADMIN_PASSWORD, "utf8");
  }
  const password = await dependencies.promptSecret("Password");
  const confirmation = await dependencies.promptSecret("Confirm password");
  if (!password.equals(confirmation)) {
    password.fill(0);
    confirmation.fill(0);
    throw new FirstAdminBootstrapError("WEAK_PASSWORD", "Password confirmation does not match");
  }
  confirmation.fill(0);
  return password;
}

export async function runSetup(
  argv: string[],
  io: SetupIo = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env },
  suppliedDependencies?: SetupDependencies,
): Promise<number> {
  try {
    const args = parseArguments(argv);
    const dependencies = suppliedDependencies ?? defaultDependencies(io);
    if (args.freshInstall && args.keepExistingTaxonomy) {
      throw new FirstAdminBootstrapError("INVALID_INSTALLATION_LINEAGE", "--fresh-install and --keep-existing-taxonomy are mutually exclusive");
    }
    let lineage: "FRESH" | "LEGACY";
    if (args.freshInstall) lineage = "FRESH";
    else if (args.keepExistingTaxonomy) lineage = "LEGACY";
    else {
      if (!io.stdin.isTTY) throw new FirstAdminBootstrapError("INVALID_INSTALLATION_LINEAGE", "Select --fresh-install or --keep-existing-taxonomy");
      const selection = (await dependencies.promptText("Installation mode (FRESH or LEGACY)")).trim().toUpperCase();
      if (selection !== "FRESH" && selection !== "LEGACY") {
        throw new FirstAdminBootstrapError("INVALID_INSTALLATION_LINEAGE", "Installation mode must be FRESH or LEGACY");
      }
      lineage = selection;
    }

    let divisionName = "";
    let divisionCode: string = "";
    if (lineage === "FRESH") {
      if (!io.stdin.isTTY && (!args.divisionName || !args.divisionCode)) {
        throw new FirstAdminBootstrapError("BOOTSTRAP_INPUT_UNAVAILABLE", "Non-interactive fresh setup requires --division-name and --division-code");
      }
      divisionName = (args.divisionName ?? await dependencies.promptText("First division name")).trim();
      if (!divisionName || divisionName.length > 120) throw new FirstAdminBootstrapError("BOOTSTRAP_INPUT_UNAVAILABLE", "Division name must contain 1-120 characters");
      divisionCode = normalizeDivisionCode(args.divisionCode ?? deriveDivisionCode(divisionName));
    } else {
      if (args.divisionName !== undefined) throw new FirstAdminBootstrapError("BOOTSTRAP_INPUT_UNAVAILABLE", "--division-name is not allowed with --keep-existing-taxonomy");
      if (!io.stdin.isTTY && !args.divisionCode) {
        throw new FirstAdminBootstrapError("BOOTSTRAP_INPUT_UNAVAILABLE", "Non-interactive legacy setup requires --division-code");
      }
      divisionCode = normalizeDivisionCode(args.divisionCode ?? await dependencies.promptText("Existing active division code"));
    }

    const name = args.name ?? await dependencies.promptText("Display name");
    const email = args.email ?? await dependencies.promptText("Email");
    const identity = normalizeFirstAdminIdentity(name, email);
    const service = dependencies.createService();
    const preview = await service.preview(lineage);
    io.stdout.write(`SETUP_PREVIEW ${JSON.stringify(preview)}\n`);
    if (!preview.eligible) throw new FirstAdminBootstrapError("FIRST_ADMIN_ALREADY_EXISTS", "First administrator already exists or installation history is present");
    if (lineage === "FRESH") assertFreshPreview(preview);
    else await service.resolveActiveDivision(divisionCode);
    if (io.stdin.isTTY) {
      const confirmation = await dependencies.promptText(`Type CONFIRM to provision ${lineage} installation for division ${divisionCode}`);
      if (confirmation !== "CONFIRM") throw new FirstAdminBootstrapError("BOOTSTRAP_INPUT_UNAVAILABLE", "Setup confirmation was not provided");
    }

    const password = await collectPassword(args, io, dependencies);
    try {
      const created = await service.provision({ ...identity, password, lineage, divisionCode, divisionName });
      io.stdout.write(`FIRST_ADMIN_CREATED user_id=${created.userId} email=${created.email}\n`);
      io.stdout.write(`authority=${created.authority} division=${created.division} role=${created.role}\n`);
      io.stdout.write("Create a second SYSTEM_ADMIN after installation to reduce single-administrator recovery risk.\n");
      return 0;
    } finally {
      password.fill(0);
    }
  } catch (error) {
    const bootstrapError = asFirstAdminBootstrapError(error);
    io.stderr.write(`${bootstrapError.code}: ${bootstrapError.message}\n`);
    return bootstrapError.exitCode;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invokedPath === import.meta.url) {
  process.exitCode = await runSetup(process.argv.slice(2));
}
