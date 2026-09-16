import type { AffiliateTaskStatusReport, ReportDrillDownResult, ReportWindow } from "../reporting/types.js";
import { compactMessageText } from "./telegram-task.js";

export const telegramOwnerMessages = {
  title: "Sotoayam Owner Console",
  buttons: { businessReport: "Business Report", criticalAlerts: "Critical Alerts", approval: "Approval",
    automationStatus: "Automation Status", acknowledge: "Acknowledge", blockedTasks: "Blocked Tasks",
    overdueTasks: "Overdue Tasks", upcomingDeadlines: "Upcoming Deadlines" },
  divisionPrompt: "Business Report\n\nPilih Divisi:",
  contentCreator: "CONTENT CREATOR",
  reportPrompt: "CONTENT CREATOR\n\nPilih report:",
  affiliateTaskStatus: "Affiliate Task Status",
  windowPrompt: "Affiliate Task Status\n\nPilih periode:",
  alertPrompt: "Critical Alerts\n\nPilih severity:",
  noActiveAlerts: "Tidak ada alert aktif.",
  noTasks: "Tidak ada task.",
  noPeriodTasks: "\nNo tasks found for this period.",
} as const;

export const reportWindowLabel = (window: ReportWindow): string => window === "TODAY" ? "Today"
  : window === "LAST_7_DAYS" ? "Last 7 Days" : "Last 30 Days";
export const reportDrillDownLabel = (kind: ReportDrillDownResult["kind"]): string => kind === "BLOCKED"
  ? telegramOwnerMessages.buttons.blockedTasks : kind === "OVERDUE" ? telegramOwnerMessages.buttons.overdueTasks
    : telegramOwnerMessages.buttons.upcomingDeadlines;
export const formatAlertList = (severity: string, count: number): string => `Critical Alerts \u2014 ${severity}\n\n${count === 0 ? telegramOwnerMessages.noActiveAlerts : `${count} alert aktif.`}`;
export function formatAffiliateReport(report: AffiliateTaskStatusReport): string {
  const rate = report.completionRate === null ? "Tidak tersedia" : `${report.completionRate.toFixed(1)}%`;
  return [telegramOwnerMessages.contentCreator, telegramOwnerMessages.affiliateTaskStatus, reportWindowLabel(report.window), "",
    `Total: ${report.total}`, `Open: ${report.open}`, `In Progress: ${report.inProgress}`, `Blocked: ${report.blocked}`,
    `Completed: ${report.completed}`, `Overdue: ${report.overdue}`, "", `Completion Rate: ${rate}`,
    `Upcoming Deadlines: ${report.upcomingDeadlines}`, report.total === 0 ? telegramOwnerMessages.noPeriodTasks : "",
  ].filter(Boolean).join("\n").slice(0, 3500);
}
export function formatReportDrillDown(result: ReportDrillDownResult): string {
  const rows = result.items.length === 0 ? telegramOwnerMessages.noTasks : result.items.map((item) =>
    `#${item.id} ${item.priority} \u00b7 ${compactMessageText(item.title, 48)}\nStatus: ${item.status}${item.deadline ? ` \u00b7 ${item.deadline.slice(0, 10)}` : ""}`).join("\n\n");
  return `${reportDrillDownLabel(result.kind)}\n${reportWindowLabel(result.window)}\n\n${rows}\n\nHalaman ${result.page + 1}/${result.pages}`.slice(0, 3500);
}
export function formatAlertDetail(item: { type: string; severity: string; status: string; affectedReference: string;
  firstDetectedAt: string; lastDetectedAt: string; occurrenceCount: number; summary: string }): string {
  return ["Critical Alert", "", `Type: ${item.type}`, `Severity: ${item.severity}`, `Status: ${item.status}`,
    `Affected: ${item.affectedReference}`, `First detected: ${item.firstDetectedAt}`, `Last detected: ${item.lastDetectedAt}`,
    `Occurrences: ${item.occurrenceCount}`, "", compactMessageText(item.summary, 500)].join("\n");
}
export function formatAutomationStatus(status: { overall: string; runtime: string; telegramPolling: string;
  reminderScheduler: string; criticalAlertEvaluator: string; notificationDelivery: string; activeIntegrations: number }): string {
  return ["Automation Status", "", `Overall: ${status.overall}`, `Sotoayam runtime: ${status.runtime}`,
    `Telegram polling: ${status.telegramPolling}`, `Reminder scheduler: ${status.reminderScheduler}`,
    `Critical Alert evaluator: ${status.criticalAlertEvaluator}`, `Notification delivery: ${status.notificationDelivery}`,
    `Active integrations: ${status.activeIntegrations}`].join("\n");
}
