import { AppError, DatabaseError } from "../errors.js";
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
import type { TaskIntakeContext, TaskIntakeOutcome, TaskIntakeRequest } from "../ingestion/types.js";
import { TaskAuthorizationService } from "./task-authorization.service.js";
import type { CollaborationPolicyResolver } from "./division-collaboration.service.js";
import type { TaskCategoryValidator } from "./task-category.service.js";

export class TaskService {
  constructor(
    private readonly tasks: TasksRepository,
    private readonly users: TaskUsersRepository,
    private readonly activities: TaskActivitiesRepository,
    private readonly relationships: TaskRelationshipsRepository,
    private readonly audit: AuditRepository,
    private readonly authorization: TaskAuthorizationService,
    private readonly now: () => Date = () => new Date(),
    private readonly collaboration?: CollaborationPolicyResolver,
    private readonly categories?: TaskCategoryValidator,
  ) {}

  async createManual(actor: TaskActor, input: CreateTaskInput): Promise<TaskReadModel> {
    this.authorization.assertCanCreate(actor);
    if (actor.divisionId === null) throw new AppError(403, "TASK_FORBIDDEN", "Creator requires a home division");
    const title = this.title(input.title);
    const ownerDivisionId = input.ownerDivisionId ?? actor.divisionId;
    if (ownerDivisionId !== actor.divisionId) {
      if (!this.collaboration) throw new AppError(409, "TASK_CROSS_DIVISION_NOT_ALLOWED", "Cross-Divisi task collaboration is not allowed");
      await this.collaboration.assertTaskCollaborationAllowed(actor.divisionId, ownerDivisionId, "ALL");
    }
    const assignedTo = await this.validateAssignee(input.assignedToUserId ?? null, ownerDivisionId);
    const task = await this.tasks.create({
      title,
      description: this.description(input.description),
      status: "OPEN",
      priority: input.priority ?? "NORMAL",
      source: "MANUAL",
      source_reference: null,
      task_category: await this.category(input.taskCategory),
      created_by_user_id: actor.id,
      integration_id: null,
      import_batch_id: null,
      requesting_division_id: actor.divisionId,
      owner_division_id: ownerDivisionId,
      assigned_to_user_id: assignedTo?.id ?? null,
      deadline: this.deadline(input.deadline),
      started_at: null,
      completed_at: null,
      cancelled_at: null,
    });
    await this.audit.append({
      actor_type: "USER", actor_user_id: actor.id, action: "TASK_CREATED", object_type: "TASK",
      object_id: String(task.id), after_state: { status: task.status, priority: task.priority,
        requesting_division_id: task.requesting_division_id, owner_division_id: task.owner_division_id }, source: "task_api",
    });
    if (assignedTo) await this.audit.append({
      actor_type: "USER", actor_user_id: actor.id, action: "TASK_ASSIGNED", object_type: "TASK",
      object_id: String(task.id), before_state: { assigned_to_user_id: null }, after_state: { assigned_to_user_id: assignedTo.id }, source: "task_api",
    });
    return this.read(task);
  }

  async createFromIntake(
    context: TaskIntakeContext,
    input: TaskIntakeRequest & { ownerDivisionId: number; assignedToUserId?: number | null },
    actor?: TaskActor,
  ): Promise<TaskIntakeOutcome> {
    await this.validateIntake(context, input, actor);
    const externalReference = this.externalReference(input.externalReference);
    const origin = context.kind === "HUMAN_IMPORT"
      ? { createdByUserId: context.actorUserId }
      : { integrationId: context.integrationId };
    if (externalReference) {
      const existing = await this.tasks.findByExternalReference({ source: input.source, sourceReference: externalReference, ...origin });
      if (existing) return { status: "DUPLICATE", taskId: existing.id };
    }
    const assignedTo = await this.validateAssignee(input.assignedToUserId ?? null, input.ownerDivisionId);
    let task: Task;
    try { task = await this.tasks.create({
      title: this.title(input.title), description: this.description(input.description), status: "OPEN",
      priority: input.priority ?? "NORMAL", source: input.source, source_reference: externalReference,
      task_category: await this.category(input.taskCategory),
      created_by_user_id: context.kind === "HUMAN_IMPORT" ? context.actorUserId : null,
      integration_id: context.kind === "HUMAN_IMPORT" ? null : context.integrationId,
      import_batch_id: context.batchId,
      requesting_division_id: context.requestingDivisionId, owner_division_id: input.ownerDivisionId,
      assigned_to_user_id: assignedTo?.id ?? null, deadline: this.deadline(input.deadline),
      started_at: null, completed_at: null, cancelled_at: null,
    }); } catch (error) {
      if (externalReference && error instanceof DatabaseError && error.diagnostic.code === "23505") {
        const existing = await this.tasks.findByExternalReference({ source: input.source, sourceReference: externalReference, ...origin });
        if (existing) return { status: "DUPLICATE", taskId: existing.id };
      }
      throw error;
    }
    const auditActor = context.kind === "HUMAN_IMPORT"
      ? { actor_type: "USER" as const, actor_user_id: context.actorUserId }
      : { actor_type: "SYSTEM" as const, actor_user_id: null };
    await this.audit.append({
      ...auditActor, action: "TASK_CREATED", object_type: "TASK", object_id: String(task.id),
      after_state: { status: task.status, priority: task.priority, source: task.source,
        requesting_division_id: task.requesting_division_id, owner_division_id: task.owner_division_id,
        import_batch_id: task.import_batch_id }, source: "task_ingestion",
    });
    if (assignedTo) await this.audit.append({
      ...auditActor, action: "TASK_ASSIGNED", object_type: "TASK", object_id: String(task.id),
      before_state: { assigned_to_user_id: null }, after_state: { assigned_to_user_id: assignedTo.id }, source: "task_ingestion",
    });
    return { status: "CREATED", task: this.read(task) };
  }

  async validateIntake(
    context: TaskIntakeContext,
    input: TaskIntakeRequest & { ownerDivisionId: number; assignedToUserId?: number | null },
    actor?: TaskActor,
  ): Promise<{ duplicateTaskId: number | null }> {
    if (context.kind === "HUMAN_IMPORT") {
      if (!actor || actor.id !== context.actorUserId) throw new AppError(403, "TASK_FORBIDDEN", "Authenticated import actor is required");
      this.authorization.assertCanCreate(actor);
      if (!actor.permissions.has("task.import")) throw new AppError(403, "TASK_FORBIDDEN", "Task import permission is required");
      if (actor.divisionId !== context.requestingDivisionId) throw new AppError(403, "TASK_FORBIDDEN", "Import requesting Divisi must be server-derived");
    }
    if (input.source === "CSV_IMPORT" && context.kind !== "HUMAN_IMPORT") throw new AppError(400, "INVALID_SOURCE_CONTEXT", "CSV import requires a human import context");
    if (input.source === "AUTOMATION" && context.kind !== "INTERNAL_AUTOMATION") throw new AppError(400, "INVALID_SOURCE_CONTEXT", "Automation source requires an automation context");
    if (input.source === "ERP" && context.kind !== "ERP_ADAPTER") throw new AppError(400, "INVALID_SOURCE_CONTEXT", "ERP source requires an ERP adapter context");
    if (input.ownerDivisionId !== context.requestingDivisionId) {
      if (!this.collaboration) throw new AppError(409, "TASK_CROSS_DIVISION_NOT_ALLOWED", "Cross-Divisi task collaboration is not allowed");
      await this.collaboration.assertTaskCollaborationAllowed(context.requestingDivisionId, input.ownerDivisionId, "ALL");
    }
    this.title(input.title);
    this.description(input.description);
    this.deadline(input.deadline);
    await this.category(input.taskCategory);
    await this.validateAssignee(input.assignedToUserId ?? null, input.ownerDivisionId);
    const externalReference = this.externalReference(input.externalReference);
    const origin = context.kind === "HUMAN_IMPORT"
      ? { createdByUserId: context.actorUserId }
      : { integrationId: context.integrationId };
    if (externalReference) {
      const existing = await this.tasks.findByExternalReference({ source: input.source, sourceReference: externalReference, ...origin });
      if (existing) return { duplicateTaskId: existing.id };
    }
    return { duplicateTaskId: null };
  }

  async get(actor: TaskActor, id: number): Promise<TaskReadModel> {
    const task = await this.required(id);
    this.authorization.assertCanView(actor, task);
    const activities = await this.activities.findForTask(task.id);
    const visible = actor.divisionId === task.owner_division_id ? activities : activities.filter((item) => item.visibility === "SHARED");
    return this.read(task, visible);
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
    if (input.taskCategory !== undefined) update.task_category = await this.category(input.taskCategory);
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
  private async category(value: Task["task_category"] | undefined): Promise<Task["task_category"]> {
    if (value === undefined || value === null) return null;
    if (!this.categories) throw new AppError(503, "TASK_CATEGORY_CATALOG_UNAVAILABLE", "Task category catalog is unavailable");
    return this.categories.validate(value);
  }
  private deadline(value: string | null | undefined): string | null {
    if (value === undefined || value === null || value === "") return null;
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) throw new AppError(400, "TASK_INVALID_DEADLINE", "Task deadline is invalid");
    return parsed.toISOString();
  }
  private externalReference(value: string | null | undefined): string | null {
    if (value === undefined || value === null || value.trim() === "") return null;
    const normalized = value.trim();
    if (normalized.length > 500) throw new AppError(400, "INVALID_EXTERNAL_REFERENCE", "External reference is too long");
    return normalized;
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
  private read(task: Task, activities?: TaskReadModel["activities"]): TaskReadModel {
    return { ...task, is_overdue: isTaskOverdue(task, this.now()), ...(activities ? { activities } : {}) };
  }
}
