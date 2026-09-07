import { defineAdminRoutes } from "../auth/admin-authorization.js";
import type { TaskActorResolver } from "../services/task-actor.service.js";
import type { TaskService } from "../services/task.service.js";
import { parsePositiveId } from "../validation.js";
import { parseActivity, parseCreateTask, parseRelationship, parseTaskFilters, parseTransition, parseUpdateTask } from "../tasks/task-validation.js";

export interface TasksRoutesOptions { service: TaskService; actorResolver: TaskActorResolver; adminApiKey?: string }

export const tasksRoutes = defineAdminRoutes<TasksRoutesOptions>(async (app, options) => {
  const actor = () => options.actorResolver.resolveTrustedActor();
  app.post("/", async (request, reply) => reply.status(201).send({ success: true, data: await options.service.createManual(await actor(), parseCreateTask(request.body)) }));
  app.get("/", async (request) => ({ success: true, data: await options.service.list(await actor(), parseTaskFilters(request.query)) }));
  app.get<{ Params: { id: string } }>("/:id", async (request) => ({ success: true, data: await options.service.get(await actor(), parsePositiveId(request.params.id)) }));
  app.patch<{ Params: { id: string } }>("/:id", async (request) => ({ success: true, data: await options.service.update(await actor(), parsePositiveId(request.params.id), parseUpdateTask(request.body)) }));
  app.post<{ Params: { id: string } }>("/:id/status", async (request) => ({ success: true, data: await options.service.transition(await actor(), parsePositiveId(request.params.id), parseTransition(request.body)) }));
  app.post<{ Params: { id: string } }>("/:id/activities", async (request, reply) => reply.status(201).send({ success: true, data: await options.service.addActivity(await actor(), parsePositiveId(request.params.id), parseActivity(request.body)) }));
  app.post<{ Params: { id: string } }>("/:id/relationships", async (request, reply) => {
    const input = parseRelationship(request.body);
    return reply.status(201).send({ success: true, data: await options.service.addRelationship(await actor(), parsePositiveId(request.params.id), input.targetId, input.type) });
  });
});
