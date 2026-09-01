import { AppError } from "../errors.js";
import { REPORT_WINDOWS, type ReportWindow } from "./types.js";

export interface ReportTimeRange { start: Date; end: Date }

export function parseReportWindow(value: unknown): ReportWindow {
  const normalized = typeof value === "string" ? value.toUpperCase() : "LAST_7_DAYS";
  if (!REPORT_WINDOWS.includes(normalized as ReportWindow)) {
    throw new AppError(400, "REPORT_WINDOW_INVALID", "Report window is invalid");
  }
  return normalized as ReportWindow;
}

export function reportTimeRange(window: ReportWindow, now: Date, timeZone: string): ReportTimeRange {
  const local = dateParts(now, timeZone);
  const daysBack = window === "TODAY" ? 0 : window === "LAST_7_DAYS" ? 6 : 29;
  const shifted = new Date(Date.UTC(local.year, local.month - 1, local.day - daysBack));
  const start = zonedMidnightUtc(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate(), timeZone);
  return { start, end: new Date(now) };
}

function dateParts(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day") };
}

function zonedMidnightUtc(year: number, month: number, day: number, timeZone: string): Date {
  const target = Date.UTC(year, month - 1, day, 0, 0, 0);
  let candidate = target;
  for (let attempt = 0; attempt < 3; attempt += 1) candidate = target - offsetAt(new Date(candidate), timeZone);
  return new Date(candidate);
}

function offsetAt(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second"))
    - Math.floor(date.getTime() / 1000) * 1000;
}
