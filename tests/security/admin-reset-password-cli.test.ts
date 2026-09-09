import { describe, expect, it, vi } from "vitest";
import { runAdminResetPassword, type AdminResetPasswordDependencies,
  type AdminResetPasswordIo } from "../../src/cli/admin-reset-password.js";

function io() {
  let stdout = "";
  let stderr = "";
  return {
    value: { stdin: { isTTY: false } as NodeJS.ReadStream,
      stdout: { write: (value: string) => { stdout += value; return true; } } as NodeJS.WriteStream,
      stderr: { write: (value: string) => { stderr += value; return true; } } as NodeJS.WriteStream } satisfies AdminResetPasswordIo,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe("administrator password reset CLI", () => {
  it("resets by email from a password file without printing credential material", async () => {
    const streams = io();
    const password = Buffer.from("Replacement-Password-92!");
    const resetPassword = vi.fn().mockResolvedValue(undefined);
    const dependencies: AdminResetPasswordDependencies = {
      createService: () => ({ resetPassword } as never),
      promptSecret: vi.fn(),
      readPasswordFile: vi.fn().mockResolvedValue(password),
    };
    expect(await runAdminResetPassword(["--email", "admin@example.test", "--password-file", "secret.input"],
      streams.value, dependencies)).toBe(0);
    expect(resetPassword).toHaveBeenCalledWith("admin@example.test", "Replacement-Password-92!");
    expect(streams.stdout()).toBe("ADMIN_PASSWORD_RESET = PASS\n");
    expect(streams.stdout() + streams.stderr()).not.toContain("Replacement-Password-92!");
    expect(password.every((byte) => byte === 0)).toBe(true);
  });

  it("requires email and refuses a noninteractive reset without a password file", async () => {
    const streams = io();
    const dependencies: AdminResetPasswordDependencies = {
      createService: () => ({ resetPassword: vi.fn() } as never),
      promptSecret: vi.fn().mockRejectedValue(new Error("no terminal")),
      readPasswordFile: vi.fn(),
    };
    expect(await runAdminResetPassword([], streams.value, dependencies)).toBe(1);
    expect(streams.stderr()).toContain("INVALID_RESET_ARGUMENT");
    expect(await runAdminResetPassword(["--email", "admin@example.test"], streams.value, dependencies)).toBe(1);
    expect(streams.stderr()).toContain("no terminal");
  });
});
