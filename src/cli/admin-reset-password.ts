import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { loadSupabaseConfig } from "../config/env.js";
import { createSupabaseClient } from "../db/supabase.js";
import { AppError } from "../errors.js";
import { SupabaseAdminSessionRepository } from "../repositories/admin-session.repository.js";
import { AdminAuthenticationService } from "../services/admin-authentication.service.js";

interface ResetArguments {
  email?: string;
  passwordFile?: string;
}

export interface AdminResetPasswordIo {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}

export interface AdminResetPasswordDependencies {
  createService(): AdminAuthenticationService;
  promptSecret(label: string): Promise<Buffer>;
  readPasswordFile(path: string): Promise<Buffer>;
}

function parseArguments(argv: string[]): ResetArguments {
  const parsed: ResetArguments = {};
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 2) {
    const argument = argv[index];
    if (argument !== "--email" && argument !== "--password-file") {
      throw new AppError(400, "INVALID_RESET_ARGUMENT", `Unsupported argument: ${argument ?? ""}`);
    }
    if (seen.has(argument)) throw new AppError(400, "INVALID_RESET_ARGUMENT", `Duplicate argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new AppError(400, "INVALID_RESET_ARGUMENT", `Missing value for ${argument}`);
    seen.add(argument);
    if (argument === "--email") parsed.email = value;
    else parsed.passwordFile = value;
  }
  if (!parsed.email) throw new AppError(400, "INVALID_RESET_ARGUMENT", "--email is required");
  return parsed;
}

async function promptSecret(io: AdminResetPasswordIo, label: string): Promise<Buffer> {
  if (!io.stdin.isTTY || typeof io.stdin.setRawMode !== "function") {
    throw new AppError(400, "RESET_INPUT_UNAVAILABLE", "A password file is required when stdin is not interactive");
  }
  io.stdout.write(`${label}: `);
  const bytes: number[] = [];
  const wasRaw = io.stdin.isRaw;
  io.stdin.setRawMode(true);
  io.stdin.resume();
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const cleanup = () => io.stdin.off("data", onData);
      const onData = (chunk: Buffer | string) => {
        const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        for (const byte of input) {
          if (byte === 3) {
            cleanup();
            reject(new AppError(400, "RESET_INPUT_UNAVAILABLE", "Password reset cancelled"));
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

function defaultDependencies(io: AdminResetPasswordIo): AdminResetPasswordDependencies {
  return {
    createService() {
      const client = createSupabaseClient(loadSupabaseConfig());
      return new AdminAuthenticationService(new SupabaseAdminSessionRepository(client), 43_200);
    },
    promptSecret: (label) => promptSecret(io, label),
    readPasswordFile: (path) => readFile(path),
  };
}

export async function runAdminResetPassword(
  argv: string[],
  io: AdminResetPasswordIo = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr },
  suppliedDependencies?: AdminResetPasswordDependencies,
): Promise<number> {
  let password: Buffer | null = null;
  let confirmation: Buffer | null = null;
  try {
    const args = parseArguments(argv);
    const dependencies = suppliedDependencies ?? defaultDependencies(io);
    if (args.passwordFile) {
      try {
        password = trimTerminalNewline(await dependencies.readPasswordFile(args.passwordFile));
      } catch {
        throw new AppError(400, "RESET_INPUT_UNAVAILABLE", "Unable to read the password file");
      }
    }
    else {
      password = await dependencies.promptSecret("New password");
      confirmation = await dependencies.promptSecret("Confirm password");
      if (!password.equals(confirmation)) throw new AppError(400, "WEAK_PASSWORD", "Password confirmation does not match");
    }
    await dependencies.createService().resetPassword(args.email!, password.toString("utf8"));
    io.stdout.write("ADMIN_PASSWORD_RESET = PASS\n");
    return 0;
  } catch (error) {
    const code = error instanceof AppError ? error.code : "ADMIN_PASSWORD_RESET_FAILED";
    const message = error instanceof Error ? error.message : "Administrator password reset failed";
    io.stderr.write(`${code}: ${message}\n`);
    return 1;
  } finally {
    password?.fill(0);
    confirmation?.fill(0);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invokedPath === import.meta.url) process.exitCode = await runAdminResetPassword(process.argv.slice(2));
