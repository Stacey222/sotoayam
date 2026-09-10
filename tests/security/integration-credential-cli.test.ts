import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { resolveIntegrationCredentialActor, runIntegrationCredentialCli } from "../../src/cli/integration-credential.js";

function output() { const stream = new PassThrough(); let value = ""; stream.on("data", (chunk) => { value += chunk; });
  return { stream, value: () => value }; }

describe("P1-04 integration credential CLI", () => {
  it("prints a newly-created credential once and persists it nowhere through the CLI", async () => {
    const stdout = output(); const stderr = output();
    const raw = `soto_${"ik"}_${"0".repeat(16)}_${"A".repeat(43)}`;
    const create = vi.fn().mockResolvedValue({ credential: raw });
    const resolveActor = vi.fn().mockResolvedValue({ id: 5 });
    const code = await runIntegrationCredentialCli(["--code", "erp_sync", "--label", "n8n production", "--email", "admin@example.test"],
      { stdout: stdout.stream as never, stderr: stderr.stream as never }, {
        resolveIntegration: vi.fn().mockResolvedValue({ id: 7 }), resolveActor, create,
      });
    expect(code).toBe(0); expect(stdout.value()).toBe(`${raw}\n`); expect(stderr.value()).toBe("");
    expect((stdout.value().match(/soto_ik_/g) ?? [])).toHaveLength(1);
    expect(resolveActor).toHaveBeenCalledWith("admin@example.test");
    expect(create).toHaveBeenCalledWith({ integrationId: 7, label: "n8n production", actorUserId: 5 });
  });

  it("requires explicit actor email and selects that active SYSTEM_ADMIN when two exist", async () => {
    const credentials = {
      findCredentialByEmail: vi.fn(async (email: string) => email === "second@example.test"
        ? { userId: 22, active: true }
        : email === "first@example.test" ? { userId: 11, active: true } : null),
    };
    const users = {
      findById: vi.fn(async (id: number) => ({ id, active: true, divisionGrantsSystemAuthority: true })),
      hasActiveSystemAdminAuthority: vi.fn(async (id: number) => id === 11 || id === 22),
    };
    await expect(resolveIntegrationCredentialActor(" SECOND@example.test ", credentials, users))
      .resolves.toEqual({ id: 22 });
    expect(credentials.findCredentialByEmail).toHaveBeenCalledWith("second@example.test");
    expect(users.findById).toHaveBeenCalledWith(22);
    expect(users.hasActiveSystemAdminAuthority).toHaveBeenCalledWith(22);
  });

  it("refuses credential creation when the actor email is omitted", async () => {
    const stdout = output(); const stderr = output(); const create = vi.fn();
    const code = await runIntegrationCredentialCli(["--code", "erp_sync", "--label", "n8n production"],
      { stdout: stdout.stream as never, stderr: stderr.stream as never }, {
        resolveIntegration: vi.fn(), resolveActor: vi.fn(), create,
      });
    expect(code).toBe(1);
    expect(stderr.value()).toContain("--email");
    expect(stdout.value()).toBe("");
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a selected user without active SYSTEM_ADMIN authority", async () => {
    await expect(resolveIntegrationCredentialActor("staff@example.test", {
      findCredentialByEmail: vi.fn().mockResolvedValue({ userId: 33, active: true }),
    }, {
      findById: vi.fn().mockResolvedValue({ id: 33, active: true, divisionGrantsSystemAuthority: true }),
      hasActiveSystemAdminAuthority: vi.fn().mockResolvedValue(false),
    })).rejects.toMatchObject({ statusCode: 403, code: "INTEGRATION_CREDENTIAL_ACTOR_FORBIDDEN" });
  });
});
