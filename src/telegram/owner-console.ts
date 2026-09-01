import { AppError } from "../errors.js";
import { parseReportWindow } from "../reporting/time-window.js";
import type { AffiliateTaskStatusReport, ReportDrillDown, ReportDrillDownResult, ReportWindow } from "../reporting/types.js";
import type { ReportingService } from "../services/reporting.service.js";
import type { TelegramTaskActorResolver } from "../services/task-actor.service.js";
import type { TelegramInlineButton } from "../services/telegram.service.js";
import type { TelegramConsoleResponse } from "./it-console.js";

export interface TelegramOwnerConsole {
  open(externalTelegramId: number): Promise<TelegramConsoleResponse>;
  handleCallback(externalTelegramId: number, data: string): Promise<TelegramConsoleResponse>;
}

const button = (text: string, callback_data: string): TelegramInlineButton => ({ text, callback_data });
const unavailable = (): TelegramConsoleResponse => ({ text: "Perintah tidak tersedia." });

export class TelegramOwnerConsoleService implements TelegramOwnerConsole {
  constructor(private readonly actors: TelegramTaskActorResolver, private readonly reports: ReportingService) {}

  async open(externalTelegramId: number): Promise<TelegramConsoleResponse> {
    const actor = await this.owner(externalTelegramId);
    return actor ? this.mainMenu() : unavailable();
  }

  async handleCallback(externalTelegramId: number, data: string): Promise<TelegramConsoleResponse> {
    const actor = await this.owner(externalTelegramId);
    if (!actor || data.length > 64) return unavailable();
    if (data === "oc:m") return this.mainMenu();
    if (data === "oc:r") return this.divisionMenu();
    if (data === "oc:d") return this.reportMenu();
    if (data === "oc:w") return this.windowMenu();
    if (["oc:c", "oc:a", "oc:s"].includes(data)) return this.placeholder();
    let match = /^oc:v:(t|7|30)$/.exec(data);
    if (match) return this.result(await this.reports.affiliateTaskStatus(actor, this.window(match[1]!)));
    match = /^oc:l:(b|o|u):(t|7|30):(\d+)$/.exec(data);
    if (match) return this.list(await this.reports.drillDown(actor, this.window(match[2]!), this.kind(match[1]!), Number(match[3])));
    return unavailable();
  }

  private async owner(externalTelegramId: number) {
    if (!Number.isSafeInteger(externalTelegramId) || externalTelegramId <= 0) return null;
    try {
      const actor = await this.actors.resolveTelegramActor(externalTelegramId);
      this.reports.assertOwner(actor);
      return actor;
    } catch (error) {
      if (error instanceof AppError && ["OWNER_REPORT_FORBIDDEN", "TASK_FORBIDDEN"].includes(error.code)) return null;
      throw error;
    }
  }

  private mainMenu(): TelegramConsoleResponse {
    return { text: "Gwens Owner Console", inlineKeyboard: [
      [button("Business Report", "oc:r")],
      [button("Critical Alerts", "oc:c"), button("Approval", "oc:a")],
      [button("Automation Status", "oc:s")],
    ] };
  }
  private divisionMenu(): TelegramConsoleResponse {
    return { text: "Business Report\n\nPilih Divisi:", inlineKeyboard: [[button("CONTENT_CREATOR", "oc:d")], [button("Back", "oc:m")]] };
  }
  private reportMenu(): TelegramConsoleResponse {
    return { text: "CONTENT CREATOR\n\nPilih report:", inlineKeyboard: [[button("Affiliate Task Status", "oc:w")], [button("Back", "oc:r")]] };
  }
  private windowMenu(): TelegramConsoleResponse {
    return { text: "Affiliate Task Status\n\nPilih periode:", inlineKeyboard: [
      [button("Today", "oc:v:t")], [button("Last 7 Days", "oc:v:7")], [button("Last 30 Days", "oc:v:30")], [button("Back", "oc:d")],
    ] };
  }
  private placeholder(): TelegramConsoleResponse {
    return { text: "Fitur belum tersedia pada Slice 8.", inlineKeyboard: [[button("Back", "oc:m")]] };
  }

  private result(report: AffiliateTaskStatusReport): TelegramConsoleResponse {
    const rate = report.completionRate === null ? "Tidak tersedia" : `${report.completionRate.toFixed(1)}%`;
    const text = ["CONTENT CREATOR", "Affiliate Task Status", this.windowLabel(report.window), "",
      `Total: ${report.total}`, `Open: ${report.open}`, `In Progress: ${report.inProgress}`,
      `Blocked: ${report.blocked}`, `Completed: ${report.completed}`, `Overdue: ${report.overdue}`, "",
      `Completion Rate: ${rate}`, `Upcoming Deadlines: ${report.upcomingDeadlines}`,
      report.total === 0 ? "\nNo tasks found for this period." : "",
    ].filter(Boolean).join("\n").slice(0, 3500);
    const code = this.windowCode(report.window);
    return { text, inlineKeyboard: [
      [button("Blocked Tasks", `oc:l:b:${code}:0`), button("Overdue Tasks", `oc:l:o:${code}:0`)],
      [button("Upcoming Deadlines", `oc:l:u:${code}:0`)],
      [button("Refresh", `oc:v:${code}`), button("Back", "oc:w")],
    ] };
  }

  private list(result: ReportDrillDownResult): TelegramConsoleResponse {
    const label = result.kind === "BLOCKED" ? "Blocked Tasks" : result.kind === "OVERDUE" ? "Overdue Tasks" : "Upcoming Deadlines";
    const rows = result.items.length === 0 ? "Tidak ada task." : result.items.map((item) =>
      `#${item.id} ${item.priority} · ${this.compact(item.title, 48)}\nStatus: ${item.status}${item.deadline ? ` · ${item.deadline.slice(0, 10)}` : ""}`).join("\n\n");
    const code = this.windowCode(result.window);
    const kind = result.kind === "BLOCKED" ? "b" : result.kind === "OVERDUE" ? "o" : "u";
    const navigation: TelegramInlineButton[] = [];
    if (result.page > 0) navigation.push(button("Previous", `oc:l:${kind}:${code}:${result.page - 1}`));
    if (result.page + 1 < result.pages) navigation.push(button("Next", `oc:l:${kind}:${code}:${result.page + 1}`));
    const keyboard: TelegramInlineButton[][] = navigation.length ? [navigation] : [];
    keyboard.push([button("Back", `oc:v:${code}`)]);
    return { text: `${label}\n${this.windowLabel(result.window)}\n\n${rows}\n\nHalaman ${result.page + 1}/${result.pages}`.slice(0, 3500), inlineKeyboard: keyboard };
  }

  private window(code: string): ReportWindow { return parseReportWindow(code === "t" ? "TODAY" : code === "7" ? "LAST_7_DAYS" : "LAST_30_DAYS"); }
  private windowCode(window: ReportWindow): "t" | "7" | "30" { return window === "TODAY" ? "t" : window === "LAST_7_DAYS" ? "7" : "30"; }
  private windowLabel(window: ReportWindow): string { return window === "TODAY" ? "Today" : window === "LAST_7_DAYS" ? "Last 7 Days" : "Last 30 Days"; }
  private kind(code: string): ReportDrillDown { return code === "b" ? "BLOCKED" : code === "o" ? "OVERDUE" : "UPCOMING"; }
  private compact(value: string, limit: number): string { const clean = value.replace(/[\r\n\t]+/g, " ").trim(); return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`; }
}
