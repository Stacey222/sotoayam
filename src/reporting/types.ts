import type { TaskPriority, TaskStatus } from "../tasks/types.js";

export const REPORT_WINDOWS = ["TODAY", "LAST_7_DAYS", "LAST_30_DAYS"] as const;
export type ReportWindow = typeof REPORT_WINDOWS[number];
export type ReportDrillDown = "BLOCKED" | "OVERDUE" | "UPCOMING";

export interface ReportTaskItem {
  id: number;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  deadline: string | null;
}

export interface AffiliateTaskStatusReport {
  definition: "AFFILIATE_TASK_STATUS";
  division: "CONTENT_CREATOR";
  taskCategory: "AFFILIATE";
  window: ReportWindow;
  timeZone: string;
  startAt: string;
  endAt: string;
  total: number;
  open: number;
  inProgress: number;
  blocked: number;
  completed: number;
  overdue: number;
  upcomingDeadlines: number;
  completionRate: number | null;
  excludedCancelled: number;
  excludedDraft: number;
}

export interface ReportDrillDownResult {
  kind: ReportDrillDown;
  window: ReportWindow;
  page: number;
  pages: number;
  total: number;
  items: ReportTaskItem[];
}
