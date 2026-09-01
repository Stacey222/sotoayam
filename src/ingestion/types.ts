import type { TaskCategory, TaskPriority, TaskReadModel, TaskSource } from "../tasks/types.js";

export const TASK_INTAKE_CONTEXTS = ["HUMAN_IMPORT", "INTERNAL_AUTOMATION", "ERP_ADAPTER"] as const;
export type TaskIntakeContextKind = typeof TASK_INTAKE_CONTEXTS[number];

export interface TaskIntakeRequest {
  externalReference?: string | null;
  title: string;
  description?: string | null;
  priority?: TaskPriority;
  source: Extract<TaskSource, "CSV_IMPORT" | "AUTOMATION" | "ERP">;
  taskCategory?: TaskCategory | null;
  ownerDivision: string;
  assignee?: string | null;
  deadline?: string | null;
  metadata?: Record<string, unknown>;
}

export type TaskIntakeContext =
  | { kind: "HUMAN_IMPORT"; actorUserId: number; requestingDivisionId: number; batchId: number }
  | { kind: "INTERNAL_AUTOMATION" | "ERP_ADAPTER"; integrationId: number; requestingDivisionId: number; batchId: number };

export interface TaskIntakeCreated { status: "CREATED"; task: TaskReadModel }
export interface TaskIntakeDuplicate { status: "DUPLICATE"; taskId: number }
export type TaskIntakeOutcome = TaskIntakeCreated | TaskIntakeDuplicate;

export interface TaskImportRowResult {
  row: number;
  status: "CREATED" | "VALID" | "DUPLICATE" | "FAILED";
  task_id?: number;
  code?: string;
  message?: string;
}

export interface TaskImportResponse {
  import_id: number;
  status: "COMPLETED" | "PARTIAL" | "FAILED";
  dry_run: boolean;
  total_rows: number;
  created_rows: number;
  failed_rows: number;
  results: TaskImportRowResult[];
}

export interface TaskSourceAdapter<TPayload = unknown> {
  normalize(payload: TPayload): Promise<TaskIntakeRequest[]>;
}
