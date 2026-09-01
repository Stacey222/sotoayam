export const TASK_STATUSES = ["DRAFT", "OPEN", "IN_PROGRESS", "BLOCKED", "COMPLETED", "CANCELLED"] as const;
export const TASK_PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
export const TASK_SOURCES = ["MANUAL", "CSV_IMPORT", "AUTOMATION", "ERP", "AI_ASSISTED"] as const;
export const TASK_ACTIVITY_TYPES = ["COMMENT", "STATUS_CHANGE", "EVIDENCE", "ASSIGNMENT_CHANGE"] as const;
export const TASK_VISIBILITIES = ["SHARED", "INTERNAL"] as const;
export const TASK_EVIDENCE_TYPES = ["NONE", "URL", "FILE_REFERENCE", "TEXT"] as const;
export const TASK_RELATIONSHIP_TYPES = ["PARENT_OF", "CHILD_OF", "BLOCKS", "BLOCKED_BY", "RELATED_TO"] as const;

export type TaskStatus = typeof TASK_STATUSES[number];
export type TaskPriority = typeof TASK_PRIORITIES[number];
export type TaskSource = typeof TASK_SOURCES[number];
export type TaskActivityType = typeof TASK_ACTIVITY_TYPES[number];
export type TaskVisibility = typeof TASK_VISIBILITIES[number];
export type TaskEvidenceType = typeof TASK_EVIDENCE_TYPES[number];
export type TaskRelationshipType = typeof TASK_RELATIONSHIP_TYPES[number];

export interface Task {
  id: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  source: TaskSource;
  source_reference: string | null;
  created_by_user_id: number | null;
  integration_id: number | null;
  import_batch_id: number | null;
  requesting_division_id: number;
  owner_division_id: number;
  assigned_to_user_id: number | null;
  deadline: string | null;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskReadModel extends Task { is_overdue: boolean; activities?: TaskActivity[] }

export interface TaskUser {
  id: number;
  displayName?: string | null;
  active: boolean;
  divisionId: number | null;
  roleId: number | null;
  roleCode: string | null;
}

export interface TaskActor extends TaskUser { permissions: ReadonlySet<string> }

export interface CreateTaskInput {
  title: string;
  description?: string | null;
  priority?: TaskPriority;
  deadline?: string | null;
  assignedToUserId?: number | null;
  ownerDivisionId?: number;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string | null;
  priority?: TaskPriority;
  deadline?: string | null;
  assignedToUserId?: number | null;
}

export interface TaskFilters {
  status?: TaskStatus;
  priority?: TaskPriority;
  assignedToUserId?: number;
  ownerDivisionId?: number;
  overdue?: boolean;
}

export interface EvidenceInput {
  type: Exclude<TaskEvidenceType, "NONE">;
  reference: string;
}

export interface TransitionTaskInput {
  status: TaskStatus;
  note?: string | null;
  evidence?: EvidenceInput | null;
}

export interface AddTaskActivityInput {
  activityType: TaskActivityType;
  note?: string | null;
  visibility?: TaskVisibility;
  evidence?: EvidenceInput | null;
}

export interface TaskActivity {
  id: number;
  task_id: number;
  actor_user_id: number;
  activity_type: TaskActivityType;
  note: string | null;
  visibility: TaskVisibility;
  evidence_type: TaskEvidenceType;
  evidence_reference: string | null;
  created_at: string;
}

export interface TaskRelationship {
  id: number;
  source_task_id: number;
  target_task_id: number;
  relationship_type: TaskRelationshipType;
  created_by_user_id: number;
  created_at: string;
}
