import type { FastifyBaseLogger } from "fastify";

export interface CorrelationContext {
  requestId?: string;
  eventId?: string;
  notificationEventId?: number;
  notificationId?: number;
  deliveryId?: number;
}

export type CorrelationLogger = Pick<FastifyBaseLogger, "info" | "warn">
  & Partial<Pick<FastifyBaseLogger, "child">>;

export function correlationBindings(context: CorrelationContext = {}): Record<string, string | number> {
  return {
    ...(context.requestId ? { request_id: context.requestId } : {}),
    ...(context.eventId ? { event_id: context.eventId } : {}),
    ...(context.notificationEventId !== undefined ? { notification_event_id: context.notificationEventId } : {}),
    ...(context.notificationId !== undefined ? { notification_id: context.notificationId } : {}),
    ...(context.deliveryId !== undefined ? { delivery_id: context.deliveryId } : {}),
  };
}

export function correlationLogger(logger: CorrelationLogger, context: CorrelationContext): CorrelationLogger {
  const bindings = correlationBindings(context);
  if (logger.child) return logger.child(bindings);
  return {
    info: (object: unknown, message?: string) => {
      if (typeof object === "string") logger.info(bindings, object);
      else logger.info({ ...bindings, ...(object as Record<string, unknown>) }, message);
    },
    warn: (object: unknown, message?: string) => {
      if (typeof object === "string") logger.warn(bindings, object);
      else logger.warn({ ...bindings, ...(object as Record<string, unknown>) }, message);
    },
  } as CorrelationLogger;
}
