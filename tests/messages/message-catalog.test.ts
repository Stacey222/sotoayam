import { describe, expect, it } from "vitest";
import { commonMessages, formatActiveTelegramAccount, formatAffiliateReport, formatAlertList,
  formatAssignmentPreview, formatAutomationStatus, formatBusinessCodeConfirmation, formatCompletePreview,
  formatReminderMessage, formatTaskInputPrompt, formatTaskList, formatTaskReview, formatUserList,
  taskErrorMessage, telegramBotMessages, telegramItMessages, telegramOwnerMessages, telegramTaskMessages } from "../../src/messages/catalog.js";
import { catalogLiteralViolations } from "../../scripts/check-message-catalog.js";

describe("P2-02 typed server message catalog", () => {
  it("C-01/C-03 keeps common and Telegram account output exact", () => {
    expect(commonMessages.commandUnavailable).toBe("Perintah tidak tersedia.");
    expect(commonMessages.requestFailed).toBe("Permintaan belum dapat diproses. Silakan coba lagi.");
    expect(telegramBotMessages.privateChatOnly.task).toBe("Task Console hanya tersedia melalui private chat.");
    expect(formatActiveTelegramAccount("OPS", "STAFF")).toBe("Akun Sotoayam aktif.\n\nDivisi: OPS\nRole: STAFF\nStatus: Aktif");
  });

  it("C-04 keeps Task Console static and dynamic output exact", () => {
    expect(telegramTaskMessages.title).toBe("Sotoayam Task Console");
    expect(formatTaskList("Open", ["#7 HIGH · Audit"], 0, 2)).toBe("My Tasks · Open\n\n#7 HIGH · Audit\n\nHalaman 1/2");
    expect(formatTaskInputPrompt("comment", 7, 2000)).toBe("Task #7\n\nKirim komentar (maksimal 2000 karakter).");
    expect(formatCompletePreview(7, "Audit")).toBe("Complete Task #7?\n\nAudit");
    expect(formatTaskReview({ title: "Audit", description: null, priority: "HIGH", requesting: "OPS", owner: "IT",
      assignee: "Unassigned", deadline: null })).toBe("Create Task · Review\n\nTitle: Audit\nDescription: None\nPriority: HIGH\nRequesting Divisi: OPS\nOwner Divisi: IT\nAssigned To: Unassigned\nDeadline: None");
    expect(taskErrorMessage("TASK_NOT_FOUND")).toBe("Task tidak lagi tersedia.");
    expect(taskErrorMessage("UNKNOWN")).toBe(commonMessages.requestFailed);
  });

  it("C-05 keeps IT Console output exact", () => {
    expect(telegramItMessages.title).toBe("Sotoayam IT Console");
    expect(formatBusinessCodeConfirmation("OPS-1")).toBe("Konfirmasi Business User Code\n\nNilai baru: OPS-1\n\nPerubahan kode yang sudah ada dapat memengaruhi integrasi.");
    expect(formatAssignmentPreview("d", "Ayu", "OPS")).toBe("Konfirmasi Perubahan\n\nUser: Ayu\nNew Division: OPS");
    expect(formatUserList("active", [], 0, 1)).toBe("Active Users\n\nTidak ada user.");
  });

  it("C-06 keeps OWNER Console output exact", () => {
    expect(telegramOwnerMessages.title).toBe("Sotoayam Owner Console");
    expect(formatAlertList("CRITICAL", 0)).toBe("Critical Alerts — CRITICAL\n\nTidak ada alert aktif.");
    expect(formatAutomationStatus({ overall: "HEALTHY", runtime: "ACTIVE", telegramPolling: "ACTIVE",
      reminderScheduler: "ACTIVE", criticalAlertEvaluator: "ACTIVE", notificationDelivery: "HEALTHY",
      activeIntegrations: 2 })).toContain("Sotoayam runtime: ACTIVE");
    expect(formatAffiliateReport({ definition: "AFFILIATE_TASK_STATUS", division: "CONTENT_CREATOR", taskCategory: "AFFILIATE",
      window: "TODAY", timeZone: "UTC", startAt: "2026-09-15T00:00:00Z", endAt: "2026-09-16T00:00:00Z",
      total: 0, open: 0, inProgress: 0, blocked: 0, completed: 0, overdue: 0, completionRate: null,
      upcomingDeadlines: 0, excludedCancelled: 0, excludedDraft: 0 })).toContain("No tasks found for this period.");
  });

  it("C-08 produces deterministic exact reminder and escalation messages", () => {
    const input = { eventType: "TASK_REMINDER" as const, title: "Periksa stok", status: "OPEN", priority: "HIGH", deadline: "2026-09-20T10:00:00Z" };
    const expected = "Pengingat tugas\n\nPeriksa stok\nStatus: OPEN\nPrioritas: HIGH\nDeadline: 2026-09-20";
    expect(formatReminderMessage(input)).toBe(expected);
    expect(formatReminderMessage(input)).toBe(expected);
    expect(formatReminderMessage({ ...input, eventType: "TASK_ESCALATION" })).toBe(expected.replace("Pengingat", "Eskalasi"));
  });

  it("C-13 bounded enforcement rejects owned duplication and ignores technical strings", () => {
    expect(catalogLiteralViolations({ "fixture.ts": `return "${commonMessages.commandUnavailable}";` })).toEqual([
      "fixture.ts: \"Perintah tidak tersedia.\"",
    ]);
    expect(catalogLiteralViolations({ "fixture.ts": `const route = "/api/tasks"; const state = "OPEN";` })).toEqual([]);
  });

  it("C-14 contains fixed Sotoayam branding and no secret-shaped catalog values", () => {
    const values = JSON.stringify({ commonMessages, telegramBotMessages, telegramItMessages, telegramOwnerMessages, telegramTaskMessages });
    expect(values).toContain("Sotoayam");
    expect(values).not.toMatch(/GWENS|password_hash|service_role|soto_ik_/i);
  });
});
