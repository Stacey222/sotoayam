import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppError } from "../errors.js";
import { asFirstAdminBootstrapError } from "../repositories/first-admin-bootstrap.repository.js";
import { secureEqual } from "../security.js";
import type { FirstOwnerBootstrapService } from "../services/first-owner-bootstrap.service.js";

const SECURE_SETUP_CSRF_COOKIE = "__Host-sotoayam_setup_csrf";
const LOCAL_SETUP_CSRF_COOKIE = "sotoayam_setup_csrf";
const BODY_FIELDS = ["display_name", "email", "password", "password_confirmation", "division_name", "business_time_zone"] as const;

export interface SetupRoutesOptions {
  service: FirstOwnerBootstrapService;
  cookieSecure: boolean;
  defaultBusinessTimeZone: string;
}

function csrfCookieName(secure: boolean): string {
  return secure ? SECURE_SETUP_CSRF_COOKIE : LOCAL_SETUP_CSRF_COOKIE;
}

function setSetupCsrf(reply: import("fastify").FastifyReply, secure: boolean): void {
  reply.setCookie(csrfCookieName(secure), randomBytes(32).toString("base64url"), {
    path: "/", secure, sameSite: "strict", httpOnly: false,
  });
}

function requireSetupCsrf(request: FastifyRequest, secure: boolean): void {
  const header = request.headers["x-csrf-token"];
  const cookie = request.cookies[csrfCookieName(secure)];
  if (typeof header !== "string" || typeof cookie !== "string" || !secureEqual(header, cookie)) {
    throw new AppError(403, "CSRF_INVALID", "A valid CSRF token is required");
  }
}

function strictBody(value: unknown): Record<(typeof BODY_FIELDS)[number], unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(400, "VALIDATION_ERROR", "Request body must be an object");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== BODY_FIELDS.length
    || BODY_FIELDS.some((field) => !(field in record))
    || Object.keys(record).some((field) => !BODY_FIELDS.includes(field as (typeof BODY_FIELDS)[number]))) {
    throw new AppError(400, "VALIDATION_ERROR", "Request body fields are invalid");
  }
  return record as Record<(typeof BODY_FIELDS)[number], unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") throw new AppError(400, "VALIDATION_ERROR", `${field} is invalid`);
  return value;
}

function divisionCode(name: string): string {
  const normalized = name.trim().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 100);
  if (!/^[A-Z][A-Z0-9_]*$/.test(normalized)) {
    throw new AppError(400, "VALIDATION_ERROR", "Nama Divisi tidak dapat digunakan");
  }
  return normalized;
}

function validateTimeZone(value: string): string {
  const timeZone = value.trim();
  if (!timeZone || timeZone.length > 100 || timeZone !== value || /[\p{Cc}]/u.test(timeZone)) {
    throw new AppError(400, "VALIDATION_ERROR", "Zona waktu tidak valid");
  }
  try { new Intl.DateTimeFormat("id-ID", { timeZone }).format(new Date(0)); }
  catch { throw new AppError(400, "VALIDATION_ERROR", "Zona waktu tidak valid"); }
  return timeZone;
}

function mapBootstrapError(error: unknown): never {
  const mapped = asFirstAdminBootstrapError(error);
  const status = mapped.code === "FIRST_ADMIN_ALREADY_EXISTS" ? 409
    : mapped.code === "INCOMPATIBLE_SCHEMA" || mapped.code === "BOOTSTRAP_TRANSACTION_FAILED" ? 503
      : 400;
  throw new AppError(status, mapped.code, mapped.message);
}

export const setupRoutes = async (app: FastifyInstance, options: SetupRoutesOptions): Promise<void> => {
  app.get("/status", { config: { rateLimit: "login" } }, async (_request, reply) => {
    const status = await options.service.getStatus().catch(mapBootstrapError);
    reply.header("Cache-Control", "no-store");
    if (status.eligible) setSetupCsrf(reply, options.cookieSecure);
    return { success: true, data: {
      required: status.eligible,
      default_business_time_zone: options.defaultBusinessTimeZone,
      password_min_length: 12,
      csrf_cookie_name: csrfCookieName(options.cookieSecure),
    } };
  });

  app.post("/", { config: { rateLimit: "login" } }, async (request, reply) => {
    requireSetupCsrf(request, options.cookieSecure);
    const value = strictBody(request.body);
    const password = text(value.password, "password");
    if (password !== text(value.password_confirmation, "password_confirmation")) {
      throw new AppError(400, "PASSWORD_CONFIRMATION_MISMATCH", "Konfirmasi kata sandi tidak cocok");
    }
    const divisionName = text(value.division_name, "division_name").trim();
    if (!divisionName || divisionName.length > 120 || /[\p{Cc}]/u.test(divisionName)) {
      throw new AppError(400, "VALIDATION_ERROR", "Nama Divisi tidak valid");
    }
    try {
      const owner = await options.service.provision({
        displayName: text(value.display_name, "display_name"),
        email: text(value.email, "email"),
        password,
        divisionName,
        divisionCode: divisionCode(divisionName),
        businessTimeZone: validateTimeZone(text(value.business_time_zone, "business_time_zone")),
      });
      reply.clearCookie(csrfCookieName(options.cookieSecure), {
        path: "/", secure: options.cookieSecure, sameSite: "strict", httpOnly: false,
      });
      return reply.status(201).send({ success: true, data: {
        user_id: owner.userId,
        role: owner.role,
        authority: owner.authority,
        password_change_required: owner.passwordChangeRequired,
      } });
    } catch (error) {
      mapBootstrapError(error);
    }
  });
};
