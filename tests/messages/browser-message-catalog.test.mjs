import { describe, expect, it } from "vitest";
import { statusLabels, uiFormatters, uiMessages } from "../../public/messages.js";

describe("P2-02 browser message catalog", () => {
  it("C-02/C-10 exposes exact side-effect-free browser copy", () => {
    expect(uiMessages.auth.invalidCredentials).toBe("Email atau kata sandi tidak valid.");
    expect(uiMessages.auth.sessionExpired).toBe("Sesi Anda telah berakhir. Silakan masuk kembali.");
    expect(uiMessages.settings.updated).toBe("Pengaturan runtime berhasil diterapkan.");
    expect(statusLabels.in_progress).toBe("Dikerjakan");
  });

  it("C-10 keeps browser formatters deterministic", () => {
    expect(uiFormatters.taskMetrics({ active: 2, overdue: 1, completed: 3 })).toBe("2 aktif · 1 terlambat · 3 selesai");
    expect(uiFormatters.authoritySummary(1, true)).toBe("SYSTEM_ADMIN efektif: 1. Anda adalah administrator efektif terakhir; lakukan serah-terima sebelum demosi.");
    expect(uiFormatters.readinessChecks({ database: "PASS", schema: "PASS", core_routes: "PASS" }))
      .toBe("Database PASS · Schema PASS · Rute inti PASS");
  });

  it("C-11/C-14 does not expose secret/storage material", () => {
    const source = JSON.stringify({ statusLabels, uiMessages });
    expect(source).toContain("Sotoayam");
    expect(source).not.toMatch(/ADMIN_API_KEY|INTERNAL_API_KEY|service.role|sessionStorage|localStorage|soto_ik_/i);
  });
});
