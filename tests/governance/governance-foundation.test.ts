import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { sanitizeAuditState } from "../../src/governance/audit-sanitizer.js";
import {
  GOVERNANCE_PERMISSIONS,
  PERMISSION_SEEDS,
  ROLE_PERMISSION_SEEDS,
  ROLE_SEEDS,
} from "../../src/governance/catalog.js";
import type { Division } from "../../src/governance/types.js";
import { SupabaseDivisionsRepository } from "../../src/repositories/divisions.repository.js";
import { LEGACY_DIVISION_SEEDS } from "../../scripts/fixtures/legacy-governance-foundation.js";

const migrationPath = path.resolve(
  process.cwd(),
  "supabase/migrations/202608290001_create_governance_foundation.sql",
);

function isUnique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

describe("Slice 1 governance catalog", () => {
  it("keeps the immutable legacy migration division fixture unique", () => {
    expect(isUnique(LEGACY_DIVISION_SEEDS.map(({ code }) => code))).toBe(true);
  });

  it("has unique role codes", () => {
    expect(isUnique(ROLE_SEEDS)).toBe(true);
  });

  it("has unique permission codes", () => {
    expect(isUnique(PERMISSION_SEEDS)).toBe(true);
  });

  it("defines the exact STAFF grant set", () => {
    expect(ROLE_PERMISSION_SEEDS.STAFF).toEqual([
      "task.view_assigned", "task.create", "task.update_assigned", "task.complete_assigned",
      "task.add_activity", "task.import",
    ]);
  });

  it("defines the exact ADMIN grant set", () => {
    expect(ROLE_PERMISSION_SEEDS.ADMIN).toEqual([
      ...ROLE_PERMISSION_SEEDS.STAFF,
      "task.view_division", "report.view_division", "alert.view_division",
    ]);
  });

  it("defines the exact OWNER grant set", () => {
    expect(ROLE_PERMISSION_SEEDS.OWNER).toEqual([
      "report.view_cross_division", "alert.view_critical", "alert.acknowledge", "approval.view", "approval.decide",
      "automation_status.view_business",
    ]);
  });

  it("does not grant governance permissions to ADMIN", () => {
    expect(ROLE_PERMISSION_SEEDS.ADMIN.some((code) => GOVERNANCE_PERMISSIONS.includes(code as never))).toBe(false);
  });

  it("does not grant technical monitoring to OWNER", () => {
    expect(ROLE_PERMISSION_SEEDS.OWNER).not.toContain("technical_monitoring.view");
  });
});

describe("Slice 1 governance boundaries", () => {
  it("accepts a dynamic division code through the repository without changing an enum", async () => {
    const created: Division = {
      id: 10, code: "CUSTOMER_SUCCESS", name: "Customer Success", active: true,
      created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(),
    };
    const single = vi.fn().mockResolvedValue({ data: created, error: null });
    const select = vi.fn().mockReturnValue({ single });
    const insert = vi.fn().mockReturnValue({ select });
    const client = { from: vi.fn().mockReturnValue({ insert }) } as unknown as SupabaseClient;

    const result = await new SupabaseDivisionsRepository(client).create({
      code: "CUSTOMER_SUCCESS",
      name: "Customer Success",
    });

    expect(insert).toHaveBeenCalledWith({ code: "CUSTOMER_SUCCESS", name: "Customer Success" });
    expect(result.code).toBe("CUSTOMER_SUCCESS");
  });

  it("keeps disabled divisions queryable for historical references", async () => {
    const inactive: Division = {
      id: 1, code: "ARCHIVE", name: "Archive", active: false,
      created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(),
    };
    const query: Record<string, unknown> = {};
    query.order = vi.fn().mockReturnValue(query);
    query.eq = vi.fn().mockReturnValue(query);
    query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [inactive], error: null }).then(resolve);
    const client = { from: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue(query) }) } as unknown as SupabaseClient;

    const result = await new SupabaseDivisionsRepository(client).findAll();

    expect(result).toEqual([inactive]);
    expect(query.eq).not.toHaveBeenCalled();
  });

  it("keeps SYSTEM_ADMIN separate from role and Telegram identity", async () => {
    const sql = await readFile(migrationPath, "utf8");
    const table = sql.match(/create table if not exists public\.system_authority_assignments \(([\s\S]*?)\n\);/)?.[1];
    expect(table).toContain("authority_code");
    expect(table).toContain("user_id");
    expect(table).not.toContain("role_id");
    expect(table).not.toContain("telegram_chat_id");
  });

  it("makes audit storage append-only", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).toContain("before update or delete on public.audit_logs");
  });

  it("redacts unsafe audit keys and secret-like values", () => {
    const sanitized = sanitizeAuditState({
      safe: "retained",
      authorization: "Bearer unsafe",
      nested: { service_role_key: "unsafe", note: "sb_secret_not-allowed" },
    });
    expect(sanitized).toEqual({
      safe: "retained",
      authorization: "[REDACTED]",
      nested: { service_role_key: "[REDACTED]", note: "[REDACTED]" },
    });
    expect(JSON.stringify(sanitized)).not.toContain("unsafe");
    expect(JSON.stringify(sanitized)).not.toContain("sb_secret");
  });
});
