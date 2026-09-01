import { AppError } from "../errors.js";
import type { ReportingRepository } from "../repositories/reporting.repository.js";
import { reportTimeRange } from "../reporting/time-window.js";
import type { AffiliateTaskStatusReport, ReportDrillDown, ReportDrillDownResult, ReportTaskItem, ReportWindow } from "../reporting/types.js";
import type { Task, TaskActor } from "../tasks/types.js";

const ACTIVE_STATUSES = new Set(["OPEN", "IN_PROGRESS", "BLOCKED"]);
const PAGE_SIZE = 5;

export class ReportingService {
  constructor(
    private readonly repository: ReportingRepository,
    private readonly timeZone: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async affiliateTaskStatus(actor: TaskActor, window: ReportWindow): Promise<AffiliateTaskStatusReport> {
    this.assertOwner(actor);
    const now = this.now();
    const range = reportTimeRange(window, now, this.timeZone);
    const tasks = await this.repository.findAffiliateTasks(range.start.toISOString(), range.end.toISOString());
    const included = tasks.filter((task) => task.status !== "CANCELLED" && task.status !== "DRAFT");
    const completed = included.filter((task) => task.status === "COMPLETED").length;
    return {
      definition: "AFFILIATE_TASK_STATUS", division: "CONTENT_CREATOR", taskCategory: "AFFILIATE",
      window, timeZone: this.timeZone, startAt: range.start.toISOString(), endAt: range.end.toISOString(),
      total: included.length,
      open: included.filter((task) => task.status === "OPEN").length,
      inProgress: included.filter((task) => task.status === "IN_PROGRESS").length,
      blocked: included.filter((task) => task.status === "BLOCKED").length,
      completed,
      overdue: included.filter((task) => this.overdue(task, now)).length,
      upcomingDeadlines: included.filter((task) => this.upcoming(task, now)).length,
      completionRate: included.length === 0 ? null : Number(((completed / included.length) * 100).toFixed(1)),
      excludedCancelled: tasks.filter((task) => task.status === "CANCELLED").length,
      excludedDraft: tasks.filter((task) => task.status === "DRAFT").length,
    };
  }

  async drillDown(actor: TaskActor, window: ReportWindow, kind: ReportDrillDown, requestedPage: number): Promise<ReportDrillDownResult> {
    this.assertOwner(actor);
    const now = this.now();
    const range = reportTimeRange(window, now, this.timeZone);
    const tasks = await this.repository.findAffiliateTasks(range.start.toISOString(), range.end.toISOString());
    const selected = tasks.filter((task) => kind === "BLOCKED" ? task.status === "BLOCKED"
      : kind === "OVERDUE" ? this.overdue(task, now) : this.upcoming(task, now));
    const pages = Math.max(1, Math.ceil(selected.length / PAGE_SIZE));
    const page = Math.min(Math.max(requestedPage, 0), pages - 1);
    return { kind, window, page, pages, total: selected.length,
      items: selected.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((task) => this.item(task)) };
  }

  assertOwner(actor: TaskActor): void {
    if (!actor.active || actor.divisionId === null || actor.roleId === null || actor.roleCode !== "OWNER") {
      throw new AppError(403, "OWNER_REPORT_FORBIDDEN", "Active normalized OWNER authority is required");
    }
  }

  private overdue(task: Task, now: Date): boolean {
    return ACTIVE_STATUSES.has(task.status) && Boolean(task.deadline && new Date(task.deadline) < now);
  }
  private upcoming(task: Task, now: Date): boolean {
    if (!ACTIVE_STATUSES.has(task.status) || !task.deadline) return false;
    const deadline = new Date(task.deadline).getTime();
    return deadline >= now.getTime() && deadline < now.getTime() + 7 * 86_400_000;
  }
  private item(task: Task): ReportTaskItem {
    return { id: task.id, title: task.title, status: task.status, priority: task.priority, deadline: task.deadline };
  }
}
