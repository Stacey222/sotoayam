import { AppError } from "../errors.js";
import { parseReportWindow } from "../reporting/time-window.js";
import type { AffiliateTaskStatusReport, ReportDrillDown, ReportDrillDownResult, ReportWindow } from "../reporting/types.js";
import type { ReportingService } from "../services/reporting.service.js";
import type { CriticalAlertService } from "../services/critical-alert.service.js";
import type { PersistedAlertSeverity } from "../alerts/types.js";
import type { TelegramTaskActorResolver } from "../services/task-actor.service.js";
import type { TelegramInlineButton } from "../services/telegram.service.js";
import type { TelegramConsoleResponse } from "./it-console.js";
import { commonMessages, compactMessageText, formatAffiliateReport, formatAlertDetail, formatAlertList,
  formatAutomationStatus, formatReportDrillDown, reportWindowLabel, telegramButtons,
  telegramOwnerMessages } from "../messages/catalog.js";

export interface TelegramOwnerConsole {
  open(externalTelegramId: number): Promise<TelegramConsoleResponse>;
  handleCallback(externalTelegramId: number, data: string): Promise<TelegramConsoleResponse>;
}

const button = (text: string, callback_data: string): TelegramInlineButton => ({ text, callback_data });
const unavailable = (): TelegramConsoleResponse => ({ text: commonMessages.commandUnavailable });

export class TelegramOwnerConsoleService implements TelegramOwnerConsole {
  constructor(
    private readonly actors: TelegramTaskActorResolver,
    private readonly reports: ReportingService,
    private readonly alerts?: CriticalAlertService,
    private readonly legacyAffiliateReportEnabled = true,
  ) {}

  async open(externalTelegramId: number): Promise<TelegramConsoleResponse> {
    const actor = await this.owner(externalTelegramId);
    return actor ? this.mainMenu() : unavailable();
  }

  async handleCallback(externalTelegramId: number, data: string): Promise<TelegramConsoleResponse> {
    const actor = await this.owner(externalTelegramId);
    if (!actor || data.length > 64) return unavailable();
    if (data === "oc:m") return this.mainMenu();
    if (!this.legacyAffiliateReportEnabled && /^(?:oc:r|oc:d|oc:w|oc:v:|oc:l:)/.test(data)) return unavailable();
    if (data === "oc:r") return this.divisionMenu();
    if (data === "oc:d") return this.reportMenu();
    if (data === "oc:w") return this.windowMenu();
    if (data === "oc:c") return this.alertMenu();
    if (data === "oc:s") return await this.automationStatus(actor);
    if (data === "oc:a") return this.placeholder();
    let alertMatch = /^oc:cf:(c|h|w|a)$/.exec(data);
    if (alertMatch) return await this.alertList(actor, alertMatch[1]!);
    alertMatch = /^oc:cd:(\d+)$/.exec(data);
    if (alertMatch) return await this.alertDetail(actor, Number(alertMatch[1]));
    alertMatch = /^oc:ca:(\d+)$/.exec(data);
    if (alertMatch) return await this.acknowledge(actor, Number(alertMatch[1]));
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
    const inlineKeyboard: TelegramInlineButton[][] = [];
    if (this.legacyAffiliateReportEnabled) inlineKeyboard.push([button(telegramOwnerMessages.buttons.businessReport, "oc:r")]);
    inlineKeyboard.push(
      [button(telegramOwnerMessages.buttons.criticalAlerts, "oc:c"), button(telegramOwnerMessages.buttons.approval, "oc:a")],
      [button(telegramOwnerMessages.buttons.automationStatus, "oc:s")],
    );
    return { text: telegramOwnerMessages.title, inlineKeyboard };
  }
  private divisionMenu(): TelegramConsoleResponse {
    return { text: telegramOwnerMessages.divisionPrompt, inlineKeyboard: [[button(telegramOwnerMessages.contentCreator, "oc:d")], [button(telegramButtons.back, "oc:m")]] };
  }
  private reportMenu(): TelegramConsoleResponse {
    return { text: telegramOwnerMessages.reportPrompt, inlineKeyboard: [[button(telegramOwnerMessages.affiliateTaskStatus, "oc:w")], [button(telegramButtons.back, "oc:r")]] };
  }
  private windowMenu(): TelegramConsoleResponse {
    return { text: telegramOwnerMessages.windowPrompt, inlineKeyboard: [
      [button(reportWindowLabel("TODAY"), "oc:v:t")], [button(reportWindowLabel("LAST_7_DAYS"), "oc:v:7")], [button(reportWindowLabel("LAST_30_DAYS"), "oc:v:30")], [button(telegramButtons.back, "oc:d")],
    ] };
  }
  private placeholder(): TelegramConsoleResponse {
    return { text: commonMessages.featureUnavailable, inlineKeyboard: [[button(telegramButtons.back, "oc:m")]] };
  }

  private alertMenu(): TelegramConsoleResponse {
    return { text: telegramOwnerMessages.alertPrompt, inlineKeyboard: [
      [button("CRITICAL", "oc:cf:c"), button("HIGH", "oc:cf:h")],
      [button("WARNING", "oc:cf:w"), button("ALL ACTIVE", "oc:cf:a")], [button(telegramButtons.back, "oc:m")],
    ] };
  }
  private async alertList(actor: Awaited<ReturnType<TelegramTaskActorResolver["resolveTelegramActor"]>>, code: string): Promise<TelegramConsoleResponse> {
    if (!this.alerts) return this.unavailableFeature();
    const severity = code === "c" ? "CRITICAL" : code === "h" ? "HIGH" : code === "w" ? "WARNING" : undefined;
    const rows = await this.alerts.list(actor, severity as PersistedAlertSeverity | undefined);
    if (!rows.length) return { text: formatAlertList(severity ?? "ALL ACTIVE", 0), inlineKeyboard: [[button(telegramButtons.back, "oc:c")]] };
    const keyboard = rows.slice(0, 8).map((item) => [button(`${item.severity} · ${compactMessageText(item.summary, 35)}`, `oc:cd:${item.id}`)]);
    keyboard.push([button(telegramButtons.refresh, `oc:cf:${code}`), button(telegramButtons.back, "oc:c")]);
    return { text: formatAlertList(severity ?? "ALL ACTIVE", rows.length), inlineKeyboard: keyboard };
  }
  private async alertDetail(actor: Awaited<ReturnType<TelegramTaskActorResolver["resolveTelegramActor"]>>, id: number): Promise<TelegramConsoleResponse> {
    if (!this.alerts) return this.unavailableFeature();
    const item = await this.alerts.get(actor, id);
    const keyboard = item.status === "OPEN" ? [[button(telegramOwnerMessages.buttons.acknowledge, `oc:ca:${id}`)], [button(telegramButtons.back, "oc:cf:a")]] : [[button(telegramButtons.back, "oc:cf:a")]];
    return { text: formatAlertDetail(item), inlineKeyboard: keyboard };
  }
  private async acknowledge(actor: Awaited<ReturnType<TelegramTaskActorResolver["resolveTelegramActor"]>>, id: number): Promise<TelegramConsoleResponse> {
    if (!this.alerts) return this.unavailableFeature();
    await this.alerts.acknowledge(actor, id);
    return this.alertDetail(actor, id);
  }
  private async automationStatus(actor: Awaited<ReturnType<TelegramTaskActorResolver["resolveTelegramActor"]>>): Promise<TelegramConsoleResponse> {
    if (!this.alerts) return this.unavailableFeature();
    const status = await this.alerts.automationStatus(actor);
    return { text: formatAutomationStatus(status), inlineKeyboard: [[button(telegramButtons.refresh, "oc:s"), button(telegramButtons.back, "oc:m")]] };
  }
  private unavailableFeature(): TelegramConsoleResponse { return { text: commonMessages.featureUnavailable, inlineKeyboard: [[button(telegramButtons.back, "oc:m")]] }; }

  private result(report: AffiliateTaskStatusReport): TelegramConsoleResponse {
    const text = formatAffiliateReport(report);
    const code = this.windowCode(report.window);
    return { text, inlineKeyboard: [
      [button(telegramOwnerMessages.buttons.blockedTasks, `oc:l:b:${code}:0`), button(telegramOwnerMessages.buttons.overdueTasks, `oc:l:o:${code}:0`)],
      [button(telegramOwnerMessages.buttons.upcomingDeadlines, `oc:l:u:${code}:0`)],
      [button(telegramButtons.refresh, `oc:v:${code}`), button(telegramButtons.back, "oc:w")],
    ] };
  }

  private list(result: ReportDrillDownResult): TelegramConsoleResponse {
    const code = this.windowCode(result.window);
    const kind = result.kind === "BLOCKED" ? "b" : result.kind === "OVERDUE" ? "o" : "u";
    const navigation: TelegramInlineButton[] = [];
    if (result.page > 0) navigation.push(button(telegramButtons.previous, `oc:l:${kind}:${code}:${result.page - 1}`));
    if (result.page + 1 < result.pages) navigation.push(button(telegramButtons.next, `oc:l:${kind}:${code}:${result.page + 1}`));
    const keyboard: TelegramInlineButton[][] = navigation.length ? [navigation] : [];
    keyboard.push([button(telegramButtons.back, `oc:v:${code}`)]);
    return { text: formatReportDrillDown(result), inlineKeyboard: keyboard };
  }

  private window(code: string): ReportWindow { return parseReportWindow(code === "t" ? "TODAY" : code === "7" ? "LAST_7_DAYS" : "LAST_30_DAYS"); }
  private windowCode(window: ReportWindow): "t" | "7" | "30" { return window === "TODAY" ? "t" : window === "LAST_7_DAYS" ? "7" : "30"; }
  private kind(code: string): ReportDrillDown { return code === "b" ? "BLOCKED" : code === "o" ? "OVERDUE" : "UPCOMING"; }
}
