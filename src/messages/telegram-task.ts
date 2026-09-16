import type { TaskPriority, TaskReadModel } from "../tasks/types.js";

export const telegramTaskMessages = {
  title: "Sotoayam Task Console",
  buttons: {
    myTasks: "My Tasks", createTask: "Create Task", startTask: "Start Task", blockTask: "Block Task",
    resumeTask: "Resume Task", completeTask: "Complete Task", addComment: "Add Comment",
    confirmComplete: "Confirm Complete", confirmCreate: "Confirm Create", unassigned: "Unassigned",
  },
  filters: {
    open: "Open", inProgress: "In Progress", blocked: "Blocked", completed: "Completed", allActive: "All Active",
  },
  filterPrompt: "My Tasks\n\nPilih filter:",
  noTasks: "Tidak ada task.",
  commentProcessing: "Komentar sedang diproses.",
  statusProcessing: "Perubahan status sedang diproses.",
  commentAdded: "Komentar berhasil ditambahkan.",
  taskBlocked: "Task berhasil diblokir.",
  taskCompleted: "Task berhasil diselesaikan.",
  taskResumed: "Task berhasil dilanjutkan.",
  taskStarted: "Task berhasil dimulai.",
  taskCreated: "Task berhasil dibuat.",
  inputCancelled: "Input dibatalkan.",
  creationCancelled: "Pembuatan task dibatalkan.",
  createTitlePrompt: "Create Task\n\nKirim title task (maksimal 200 karakter).",
  invalidTitle: "Title wajib berisi 1-200 karakter.",
  descriptionPrompt: "Kirim description task (maksimal 2000 karakter), atau pilih Skip.",
  invalidDeadline: "Deadline tidak valid. Gunakan format YYYY-MM-DD.",
  priorityPrompt: "Pilih priority:",
  ownerPrompt: "Pilih owner Divisi:",
  assigneePrompt: "Pilih assignee:",
  deadlinePrompt: "Kirim deadline dengan format YYYY-MM-DD, atau pilih Skip.",
} as const;

export function compactMessageText(value: string, limit: number): string {
  const clean = value.replace(/[\r\n\t]+/g, " ").trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}\u2026`;
}

export function formatTaskMenu(notice?: string): string {
  return `${notice ? `${notice}\n\n` : ""}${telegramTaskMessages.title}`;
}

export function formatTaskList(label: string, summaries: readonly string[], page: number, pages: number): string {
  return summaries.length === 0
    ? `My Tasks \u00b7 ${label}\n\n${telegramTaskMessages.noTasks}`
    : `My Tasks \u00b7 ${label}\n\n${summaries.join("\n")}\n\nHalaman ${page + 1}/${pages}`;
}

export function formatTaskSummary(task: Pick<TaskReadModel, "id" | "priority" | "title" | "is_overdue">): string {
  return `#${task.id} ${task.priority} \u00b7 ${compactMessageText(task.title, 50)}${task.is_overdue ? " \u00b7 OVERDUE" : ""}`;
}

export function formatTaskButton(id: number, title: string): string {
  return `#${id} \u00b7 ${compactMessageText(title, 35)}`;
}

export function formatTaskDetail(input: {
  task: TaskReadModel; requesting: string; owner: string; assignee: string; notice?: string;
}): string {
  const { task } = input;
  return [
    ...(input.notice ? [input.notice, ""] : []), `Task #${task.id}`, "", `Title: ${task.title}`,
    ...(task.description ? [`Description: ${compactMessageText(task.description, 800)}`] : []),
    `Status: ${task.status}`, `Priority: ${task.priority}`, `Requesting Divisi: ${input.requesting}`,
    `Owner Divisi: ${input.owner}`, `Assigned To: ${input.assignee}`,
    `Deadline: ${task.deadline ? task.deadline.slice(0, 10) : "None"}`, `Overdue: ${task.is_overdue ? "Yes" : "No"}`,
    `Created: ${task.created_at.slice(0, 10)}`,
  ].join("\n");
}

export const formatTaskInputPrompt = (kind: "comment" | "block", taskId: number, maxComment: number): string => kind === "comment"
  ? `Task #${taskId}\n\nKirim komentar (maksimal ${maxComment} karakter).`
  : `Task #${taskId}\n\nKirim alasan task diblokir.`;
export const formatInvalidComment = (maximum: number): string => `Komentar wajib berisi 1-${maximum} karakter.`;
export const formatInvalidBlockReason = (maximum: number): string => `Alasan wajib berisi 1-${maximum} karakter.`;
export const formatInvalidDescription = (maximum: number): string => `Description maksimal ${maximum} karakter.`;
export const formatCompletePreview = (id: number, title: string): string => `Complete Task #${id}?\n\n${title}`;

export function formatTaskReview(input: { title: string; description: string | null | undefined; priority: TaskPriority;
  requesting: string; owner: string; assignee: string; deadline: string | null | undefined }): string {
  return ["Create Task \u00b7 Review", "", `Title: ${input.title}`, `Description: ${input.description || "None"}`,
    `Priority: ${input.priority}`, `Requesting Divisi: ${input.requesting}`, `Owner Divisi: ${input.owner}`,
    `Assigned To: ${input.assignee}`, `Deadline: ${input.deadline?.slice(0, 10) || "None"}`].join("\n");
}

export function taskErrorMessage(code: string): string {
  switch (code) {
    case "TASK_NOT_FOUND": return "Task tidak lagi tersedia.";
    case "TASK_FORBIDDEN": return "Anda tidak memiliki izin untuk task ini.";
    case "TASK_INVALID_STATUS_TRANSITION": return "Status task sudah berubah atau transisi tidak tersedia.";
    case "TASK_CROSS_DIVISION_NOT_ALLOWED": return "Kolaborasi Cross-Divisi tidak tersedia.";
    case "TASK_COLLABORATION_APPROVAL_REQUIRED": return "Kolaborasi ini memerlukan approval dan belum tersedia di Telegram.";
    case "TASK_INVALID_ASSIGNEE": return "Assignee tidak lagi tersedia.";
    case "TASK_INACTIVE_ASSIGNEE": return "Assignee tidak lagi aktif.";
    case "TASK_INVALID_DEADLINE": return "Deadline tidak valid.";
    case "VALIDATION_ERROR": return "Input tidak valid. Periksa kembali data Anda.";
    default: return "Permintaan belum dapat diproses. Silakan coba lagi.";
  }
}
