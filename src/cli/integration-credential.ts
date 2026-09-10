import { pathToFileURL } from "node:url";
import { loadSupabaseConfig } from "../config/env.js";
import { createSupabaseClient } from "../db/supabase.js";
import { AppError } from "../errors.js";
import { SupabaseAdminSessionRepository } from "../repositories/admin-session.repository.js";
import { SupabaseIntegrationAdministrationRepository } from "../repositories/integration-administration.repository.js";
import { SupabaseIntegrationCredentialRepository } from "../repositories/integration-credential.repository.js";
import { SupabaseTaskUsersRepository } from "../repositories/task-users.repository.js";
import { IntegrationCredentialService } from "../services/integration-credential.service.js";

interface Arguments { code?: string; label?: string; email?: string }
export interface IntegrationCredentialCliIo { stdout: NodeJS.WriteStream; stderr: NodeJS.WriteStream }
export interface IntegrationCredentialCliDependencies {
  resolveIntegration(code: string): Promise<{ id: number } | null>;
  resolveActor(email: string): Promise<{ id: number }>;
  create(input: { integrationId: number; label: string; actorUserId: number }): Promise<{ credential: string }>;
}

function parseArguments(argv: string[]): Required<Arguments> {
  const result: Arguments = {};
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (name !== "--code" && name !== "--label" && name !== "--email") throw new AppError(400, "INVALID_CREDENTIAL_ARGUMENT", `Unsupported argument: ${name ?? ""}`);
    if (seen.has(name)) throw new AppError(400, "INVALID_CREDENTIAL_ARGUMENT", `Duplicate argument: ${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new AppError(400, "INVALID_CREDENTIAL_ARGUMENT", `Missing value for ${name}`);
    seen.add(name);
    if (name === "--code") result.code = value.trim().toUpperCase();
    else if (name === "--email") result.email = value.trim().toLocaleLowerCase("en-US");
    else result.label = value;
  }
  if (!result.code || !result.label || !result.email) {
    throw new AppError(400, "INVALID_CREDENTIAL_ARGUMENT", "--code, --label and --email are required");
  }
  return result as Required<Arguments>;
}

interface AdminActorCredentialLookup {
  findCredentialByEmail(email: string): Promise<{ userId: number; active: boolean } | null>;
}

interface AdminActorAuthorityLookup {
  findById(id: number): Promise<{ id: number; active: boolean; divisionGrantsSystemAuthority?: boolean } | null>;
  hasActiveSystemAdminAuthority(userId: number): Promise<boolean>;
}

export async function resolveIntegrationCredentialActor(email: string, credentials: AdminActorCredentialLookup,
  users: AdminActorAuthorityLookup): Promise<{ id: number }> {
  const normalizedEmail = email.trim().toLocaleLowerCase("en-US");
  const credential = normalizedEmail ? await credentials.findCredentialByEmail(normalizedEmail) : null;
  const user = credential?.active ? await users.findById(credential.userId) : null;
  const authorized = user?.active === true && user.divisionGrantsSystemAuthority === true
    && await users.hasActiveSystemAdminAuthority(user.id);
  if (!authorized || !user) {
    throw new AppError(403, "INTEGRATION_CREDENTIAL_ACTOR_FORBIDDEN",
      "Selected administrator must be an active SYSTEM_ADMIN in an authority-capable division");
  }
  return { id: user.id };
}

function dependencies(): IntegrationCredentialCliDependencies {
  const client = createSupabaseClient(loadSupabaseConfig());
  const integrations = new SupabaseIntegrationAdministrationRepository(client);
  const adminCredentials = new SupabaseAdminSessionRepository(client);
  const actors = new SupabaseTaskUsersRepository(client);
  const credentials = new IntegrationCredentialService(new SupabaseIntegrationCredentialRepository(client));
  return {
    resolveIntegration: async (code) => (await integrations.list()).find((item) => item.code === code) ?? null,
    resolveActor: (email) => resolveIntegrationCredentialActor(email, adminCredentials, actors),
    create: (input) => credentials.create(input),
  };
}

export async function runIntegrationCredentialCli(argv: string[],
  io: IntegrationCredentialCliIo = { stdout: process.stdout, stderr: process.stderr },
  supplied?: IntegrationCredentialCliDependencies): Promise<number> {
  try {
    const args = parseArguments(argv);
    const deps = supplied ?? dependencies();
    const integration = await deps.resolveIntegration(args.code);
    if (!integration) throw new AppError(404, "INTEGRATION_NOT_FOUND", "Integration identity not found");
    const actor = await deps.resolveActor(args.email);
    const created = await deps.create({ integrationId: integration.id, label: args.label, actorUserId: actor.id });
    io.stdout.write(`${created.credential}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof AppError ? error.code : "INTEGRATION_CREDENTIAL_CREATE_FAILED";
    const message = error instanceof Error ? error.message : "Unable to create integration credential";
    io.stderr.write(`${code}: ${message}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invokedPath === import.meta.url) process.exitCode = await runIntegrationCredentialCli(process.argv.slice(2));
