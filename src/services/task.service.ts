import { AppError } from "../errors.js";
import type { AuditRepository } from "../repositories/audit.repository.js";
import type { TaskActivitiesRepository } from "../repositories/task-activities.repository.js";
import type { TaskRelationshipsRepository } from "../repositories/task-relationships.repository.js";
import type { TaskUsersRepository } from "../repositories/task-users.repository.js";
import type { TasksRepository } from "../repositories/tasks.repository.js";
import { isTaskOverdue, lifecycleTimestamps } from "../tasks/task-lifecycle.js";
import type {
  AddTaskActivityInput, CreateTaskInput, EvidenceInput, Task, TaskActor, TaskFilters,
  TaskReadModel, TaskRelationshipType, TransitionTaskInput, UpdateTaskInput,
} from "../tasks/types.js";
import { TaskAuthorizationService } from "./task-authorization.service.js";

export class TaskService {
  constructor(
    private readonly tasks: TasksRepository,
    private readonly users: TaskUsersRepository,
    private readonly activities: TaskActivitiesRepository,
    private readonly relationships: TaskRelationshipsRepository,
    private readonly audit: AuditRepository,
    private readonly authorization: TaskAuthorizationService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createManual(actor: TaskActor, input: CreateTaskInput): Promise<TaskReadModel> {
    this.authorization.assertCanCreate(actor);
    if (actor.divisionId === null) throw new AppError(403, "TASK_FORBIDDEN", "Creator requires a home division");
    const title = this.title(input.title);
    const assignedTo = await this.validateAssignee(input.assignedToUserId ?? null, actor.divisionId);
    const task = await this.tasks.create({
      title,
      description: this.description(input.description),
      status: "OPEN",
      priority: input.priority ?? "NORMAL",
      source: "MANUAL",
      source_reference: null,
      created_by_user_id: actor.id,
      requesting_division_id: actor.divisionId,
      owner_division_id: actor.divisionId,
      assigned_to_user_id: assignedTo?.id ?? null,
      deadline: this.deadline(input.deadline),
      started_at: null,
      completed_at: null,
      cancelled_at: null,
    });
    await this.audit.append({
      actor_type: "USER", actor_user_id: actor.id, action: "TASK_CREATED", object_type: "TASK",
      object_id: String(task.id), after_state: { status: task.status, priority: task.priority, owner_division_id: task.owner_division_id }, source: "task_api",
    });
    if (assignedTo) await this.audit.append({
      actor_type: "USER", actor_user_id: actor.id, action: "TASK_ASSIGNED", object_type: "TASK",
      object_id: String(task.id), before_state: { assigned_to_user_id: null }, after_state: { assigned_to_user_id: assignedTo.id }, source: "task_api",
    });
    return this.read(task);
  }

  async get(actor: TaskActor, id: number): Promise<TaskReadModel> {
    const task = await this.required(id);
    this.authorization.assertCanView(actor, task);
    return this.read(task);
  }

  async list(actor: TaskActor, filters: TaskFilters): Promise<TaskReadModel[]> {
    return (await this.tasks.findAll(filters)).filter((task) => this.authorization.canView(actor, task));
  }

  async update(actor: TaskActor, id: number, input: UpdateTaskInput): Promise<TaskReadModel> {
    const task = await this.required(id);
    this.authorization.assertCanUpdate(actor, task);
    const update: Parameters<TasksRepository["update"]>[1] = {};
    if (input.title !== undefined) update.title = this.title(input.title);
    if (input.description !== undefined) update.description = this.description(input.description);
    if (input.priority !== undefined) update.priority = input.priority;
    if (input.deadline !== undefined) update.deadline = this.deadline(input.deadline);
    let assignmentChanged = false;
    if (input.assignedToUserId !== undefined) {
      const assignee = await this.validateAssignee(input.assignedToUserId, task.owner_division_id);
      update.assigned_to_user_id = assignee?.id ?? null;
      assignmentChanged = task.assigned_to_user_id !== update.assigned_to_user_id;
    }
    if (Object.keys(update).length === 0) throw new AppError(400, "VALIDATION_ERROR", "At least one task field is required");
    const changed = await this.tasks.update(id, update);
    await this.audit.append({
      actor_type: "USER", actor_user_id: actor.id, action: "TASK_UPDATED", object_type: "TASK", object_id: String(id),
      before_state: { title: task.title, priority: task.priority, deadline: task.deadline },
      after_state: { title: changed.title, priority: changed.priority, deadline: changed.deadline }, source: "task_api",
    });
    if (assignmentChanged) {
      await this.activities.append({ task_id: id, actor_user_id: actor.id, activity_type: "ASSIGNMENT_CHANGE", note: null,
        visibility: "INTERNAL", evidence_type: "NONE", evidence_reference: null });
      await this.audit.append({
        actor_type: "USER", actor_user_id: actor.id, action: "TASK_ASSIGNED", object_type: "TASK", object_id: String(id),
        before_state: { assigned_to_user_id: task.assigned_to_user_id }, after_state: { assigned_to_user_id: changed.assigned_to_user_id }, source: "task_api",
      });
    }
    return this.read(changed);
  }

  async transition(actor: TaskActor, id: number, input: TransitionTaskInput): Promise<TaskReadModel> {
    const task = await this.required(id);
    if (input.status === "COMPLETED") this.authorization.assertCanComplete(actor, task);
    else this.authorization.assertCanUpdate(actor, task);
    if (input.status === "BLOCKED" && !input.note?.trim()) {
      throw new AppError(400, "VALIDATION_ERROR", "Blocked status requires a reason");
    }
    const validatedEvidence = input.evidence ? this.evidence(input.evidence) : null;
    const timestamps = lifecycleTimestamps(task, input.status, this.now());
    const changed = await this.tasks.update(id, { status: input.status, ...timestamps });
    await this.activities.append({
      task_id: id, actor_user_id: actor.id, activity_type: "STATUS_CHANGE",
      note: input.note?.trim() || null, visibility: "SHARED", evidence_type: "NONE", evidence_reference: null,
    });
    if (validatedEvidence) await this.appendEvidence(actor, id, validatedEvidence, input.note);
    await this.audit.append({
      actor_type: "USER", actor_user_id: actor.id, action: "TASK_STATUS_CHANGED", object_type: "TASK", object_id: String(id),
      before_state: { status: task.status }, after_state: { status: changed.status }, source: "task_api",
    });
    if (changed.status === "COMPLETED" || changed.status === "CANCELLED") await this.audit.append({
      actor_type: "USER", actor_user_id: actor.id,
      action: changed.status === "COMPLETED" ? "TASK_COMPLETED" : "TASK_CANCELLED",
      object_type: "TASK", object_id: String(id), before_state: { status: task.status }, after_state: { status: changed.status }, source: "task_api",
    });
    return this.read(changed);
  }

  async addActivity(actor: TaskActor, id: number, input: AddTaskActivityInput) {
    const task = await this.required(id);
    this.authorization.assertCanAddActivity(actor, task);
    if (input.activityType === "EVIDENCE" && !input.evidence) throw new AppError(400, "VALIDATION_ERROR", "Evidence activity requires evidence");
    if (input.activityType === "COMMENT" && !input.note?.trim()) throw new AppError(400, "VALIDATION_ERROR", "Comment activity requires a note");
    const evidence = input.evidence ? this.evidence(input.evidence) : null;
    return this.activities.append({
      task_id: id, actor_user_id: actor.id, activity_type: input.activityType,
      note: input.note?.trim() || null, visibility: input.visibility ?? "SHARED",
      evidence_type: evidence?.type ?? "NONE", evidence_reference: evidence?.reference ?? null,
    });
  }

  async addRelationship(actor: TaskActor, sourceId: number, targetId: number, type: TaskRelationshipType) {
    if (sourceId === targetId) throw new AppError(400, "TASK_RELATIONSHIP_INVALID", "Task cannot relate to itself");
    const [source, target] = await Promise.all([this.required(sourceId), this.required(targetId)]);
    this.authorization.assertCanUpdate(actor, source);
    this.authorization.assertCanView(actor, target);
    if (await this.relationships.findExact(sourceId, targetId, type)) {
      throw new AppError(409, "TASK_RELATIONSHIP_INVALID", "Duplicate task relationship");
    }
    const relationship = await this.relationships.create({ source_task_id: sourceId, target_task_id: targetId, relationship_type: type, created_by_user_id: actor.id });
    await this.audit.append({
      actor_type: "USER", actor_user_id: actor.id, action: "TASK_RELATIONSHIP_CREATED", object_type: "TASK_RELATIONSHIP",
      object_id: String(relationship.id), after_state: { source_task_id: sourceId, target_task_id: targetId, relationship_type: type }, source: "task_api",
    });
    return relationship;
  }

  private async required(id: number): Promise<Task> {
    const task = await this.tasks.findById(id);
    if (!task) throw new AppError(404, "TASK_NOT_FOUND", "Task not found");
    return task;
  }

  private async validateAssignee(id: number | null, ownerDivisionId: number): Promise<Awaited<ReturnType<TaskUsersRepository["findById"]>>> {
    if (id === null) return null;
    const user = await this.users.findById(id);
    if (!user) throw new AppError(400, "TASK_INVALID_ASSIGNEE", "Assignee not found");
    if (!user.active) throw new AppError(400, "TASK_INACTIVE_ASSIGNEE", "Assignee is inactive");
    if (user.divisionId === null || user.roleId === null) throw new AppError(400, "TASK_INVALID_ASSIGNEE", "Assignee onboarding is incomplete");
    if (user.divisionId !== ownerDivisionId) throw new AppError(409, "TASK_CROSS_DIVISION_NOT_ALLOWED", "Cross-Divisi assignment is not available");
    return user;
  }

  private title(value: string): string {
    const title = value?.trim();
    if (!title || title.length > 200) throw new AppError(400, "VALIDATION_ERROR", "Task title must contain 1-200 characters");
    return title;
  }
  private description(value: string | null | undefined): string | null {
    if (value === undefined || value === null || value.trim() === "") return null;
    if (value.length > 10000) throw new AppError(400, "VALIDATION_ERROR", "Task description is too long");
    return value.trim();
  }
  private deadline(value: string | null | undefined): string | null {
    if (value === undefined || value === null || value === "") return null;
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) throw new AppError(400, "TASK_INVALID_DEADLINE", "Task deadline is invalid");
    return parsed.toISOString();
  }
  private evidence(input: EvidenceInput): EvidenceInput {
    const reference = input.reference.trim();
    if (!reference || reference.length > 5000) throw new AppError(400, "VALIDATION_ERROR", "Evidence reference is invalid");
    if (input.type === "URL") {
      let url: URL;
      try { url = new URL(reference); } catch { throw new AppError(400, "VALIDATION_ERROR", "Evidence URL is invalid"); }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new AppError(400, "VALIDATION_ERROR", "Evidence URL is unsafe");
    }
    if (input.type === "FILE_REFERENCE" && (/\.\.|[\u0000-\u001f]/.test(reference))) {
      throw new AppError(400, "VALIDATION_ERROR", "Evidence file reference is unsafe");
    }
    return { type: input.type, reference };
  }
  private async appendEvidence(actor: TaskActor, taskId: number, evidenceInput: EvidenceInput, note?: string | null) {
    const evidence = this.evidence(evidenceInput);
    return this.activities.append({ task_id: taskId, actor_user_id: actor.id, activity_type: "EVIDENCE",
      note: note?.trim() || null, visibility: "SHARED", evidence_type: evidence.type, evidence_reference: evidence.reference });
  }
  private read(task: Task): TaskReadModel { return { ...task, is_overdue: isTaskOverdue(task, this.now()) }; }
}
