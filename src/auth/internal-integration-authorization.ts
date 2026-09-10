import type { FastifyRequest } from "fastify";
import type { AuditRepository } from "../repositories/audit.repository.js";
import { secureEqual } from "../security.js";
import { integrationUnauthorized, type IntegrationCredentialAuthenticator,
  type IntegrationPrincipal } from "./integration-credential.js";
import type { IntegrationCapabilityCode } from "../repositories/task-ingestion.repository.js";

export const INTEGRATION_KEY_HEADER = "x-integration-key";
export const INTERNAL_API_KEY_HEADER = "x-internal-api-key";

export interface InternalIntegrationAuthorizationOptions {
  credentials?: IntegrationCredentialAuthenticator;
  internalApiKey: string;
  internalApiKeyFallbackEnabled?: boolean;
  onInternalApiKeyFallback?: () => void | Promise<void>;
}

export type InternalIntegrationAuthorization =
  | { kind: "integration-credential"; principal: IntegrationPrincipal }
  | { kind: "legacy-internal-api-key" };

export async function authorizeInternalIntegration(
  request: FastifyRequest,
  options: InternalIntegrationAuthorizationOptions,
  requiredCapability: IntegrationCapabilityCode | null,
): Promise<InternalIntegrationAuthorization> {
  const integrationCredential = request.headers[INTEGRATION_KEY_HEADER];
  if (integrationCredential !== undefined) {
    if (!options.credentials) throw integrationUnauthorized();
    return { kind: "integration-credential",
      principal: await options.credentials.authenticate(integrationCredential, requiredCapability) };
  }
  const legacyCredential = request.headers[INTERNAL_API_KEY_HEADER];
  if (options.internalApiKeyFallbackEnabled === false || typeof legacyCredential !== "string"
    || !secureEqual(legacyCredential, options.internalApiKey)) {
    throw integrationUnauthorized();
  }
  await options.onInternalApiKeyFallback?.();
  return { kind: "legacy-internal-api-key" };
}

export class InternalApiKeyFallbackObserver {
  private observation?: Promise<void>;

  constructor(private readonly audit: AuditRepository,
    private readonly warn: (message: string) => void = () => undefined) {}

  async observe(): Promise<void> {
    if (!this.observation) this.observation = (async () => {
      this.warn("INTERNAL_API_KEY compatibility fallback used");
      await this.audit.append({ actor_type: "SYSTEM", actor_user_id: null,
        action: "INTERNAL_API_KEY_FALLBACK_USED", object_type: "INTEGRATION_CREDENTIAL", object_id: "PROCESS",
        before_state: null, after_state: { fallback: true }, source: "integration_credential_auth" });
    })();
    try { await this.observation; }
    catch (error) { this.observation = undefined; throw error; }
  }
}
