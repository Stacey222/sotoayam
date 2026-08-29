import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { mapLegacyDivision, mapLegacyRole } from "../../src/identity/legacy-mapping.js";
import type {
  ChannelIdentitySnapshot,
  LegacyIdentitySnapshot,
  NormalizedIdentitySnapshot,
} from "../../src/identity/types.js";
import { SupabaseNormalizedRegistrationRepository } from "../../src/repositories/normalized-registration.repository.js";
import { reconcileIdentitySnapshots } from "../../src/services/identity-reconciliation.service.js";
import { TelegramRegistrationService } from "../../src/services/telegram-registration.service.js";

const migrationPath = path.resolve(
  process.cwd(),
  "supabase/migrations/202608290002_create_normalized_identity.sql",
);

const legacy: LegacyIdentitySnapshot = {
  id: 1,
  telegram_chat_id: 1001,
  division: "Purchasing",
  role: "Staff",
  active: true,
};

const normalized: NormalizedIdentitySnapshot = {
  id: 10,
  legacy_telegram_user_id: 1,
  division_code: "PURCHASING",
  role_code: "STAFF",
  active: true,
};

const channel: ChannelIdentitySnapshot = {
  id: 20,
  user_id: 10,
  channel_type: "TELEGRAM",
  external_id: "1001",
};

describe("Slice 2 normalized schema contract", () => {
  it("enforces one normalized user per legacy user", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).toContain("legacy_telegram_user_id bigint unique");
  });

  it("enforces one mapping per Telegram external identity", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).toContain("unique (channel_type, external_id)");
  });

  it("makes both backfill writes repeatable", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).toContain("on conflict (legacy_telegram_user_id) do update");
    expect(sql).toContain("on conflict (channel_type, external_id) do update");
  });

  it("rejects duplicate legacy Telegram identities before backfill", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).toContain("raise exception 'Duplicate legacy Telegram identity'");
  });

  it("does not place Telegram or routing fields in users", async () => {
    const sql = await readFile(migrationPath, "utf8");
    const table = sql.match(/create table if not exists public\.users \(([\s\S]*?)\n\);/)?.[1] ?? "";
    expect(table).not.toMatch(/telegram_chat_id|telegram_username|stock_alert|purchase_alert|sales_alert|marketing_alert|content_alert|owner_report|system_error/);
  });

  it("does not migrate notification preferences into user_channels", async () => {
    const sql = await readFile(migrationPath, "utf8");
    const table = sql.match(/create table if not exists public\.user_channels \(([\s\S]*?)\n\);/)?.[1] ?? "";
    expect(table).not.toMatch(/stock_alert|purchase_alert|sales_alert|marketing_alert|content_alert|owner_report|system_error/);
  });

  it("keeps onboarding assignments nullable without fake catalog entries", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).toContain("division_id bigint references");
    expect(sql).toContain("role_id bigint references");
    expect(sql).not.toMatch(/insert into public\.(?:divisions|roles)[\s\S]*UNASSIGNED/i);
    expect(mapLegacyDivision("UNASSIGNED")).toBeNull();
    expect(mapLegacyRole("UNASSIGNED")).toBeNull();
  });

  it("never auto-assigns SYSTEM_ADMIN", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).not.toMatch(/insert into public\.system_authority_assignments/i);
  });

  it("preserves admin-managed normalized configuration during /start refresh", async () => {
    const sql = await readFile(migrationPath, "utf8");
    const functionSql = sql.split("create or replace function public.register_telegram_identity")[1] ?? "";
    expect(functionSql).toContain("display_name = coalesce(users.display_name, excluded.display_name)");
    expect(functionSql).not.toContain("division_id = excluded.division_id");
    expect(functionSql).not.toContain("role_id = excluded.role_id");
    expect(functionSql).not.toContain("active = excluded.active");
  });

  it("records bounded identity audit events without Telegram identifiers", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).toContain("'USER_BACKFILLED'");
    expect(sql).toContain("'CHANNEL_LINKED'");
    const auditPayloads = [...sql.matchAll(/jsonb_build_object\(([^;]+?)\)/g)].map((match) => match[1]).join(" ");
    expect(auditPayloads).not.toMatch(/telegram_chat_id|external_id|username/);
  });
});

describe("legacy catalog mapping", () => {
  it("maps all confirmed Divisi values", () => {
    expect([
      "Purchasing", "Sales Grosir", "Digital Marketing", "Content Creator", "On Page / B2C",
      "Live Shopee", "Gudang", "Management", "IT",
    ].map(mapLegacyDivision)).toEqual([
      "PURCHASING", "SALES_GROSIR", "DIGITAL_MARKETING", "CONTENT_CREATOR", "ONPAGE_B2C",
      "SHOPEE_LIVE", "GUDANG", "MANAGEMENT", "IT",
    ]);
  });

  it("maps only confirmed business roles", () => {
    expect(["Staff", "Admin", "Owner"].map(mapLegacyRole)).toEqual(["STAFF", "ADMIN", "OWNER"]);
    expect(mapLegacyRole("Manager")).toBeUndefined();
  });
});

describe("identity reconciliation", () => {
  it("classifies a complete identity as MATCH and preserves active state", () => {
    expect(reconcileIdentitySnapshots([legacy], [normalized], [channel])).toEqual({
      match: 1, missingNormalized: 0, missingLegacy: 0, mismatch: 0, duplicate: 0,
    });
  });

  it("classifies a missing normalized identity", () => {
    expect(reconcileIdentitySnapshots([legacy], [], [])).toMatchObject({ missingNormalized: 1, match: 0 });
  });

  it("classifies a missing legacy identity", () => {
    expect(reconcileIdentitySnapshots([], [normalized], [channel])).toMatchObject({ missingLegacy: 2, match: 0 });
  });

  it("classifies assignment or active-state mismatch", () => {
    expect(reconcileIdentitySnapshots([legacy], [{ ...normalized, active: false }], [channel])).toMatchObject({
      mismatch: 1, match: 0,
    });
  });

  it("detects duplicate normalized and channel identities", () => {
    const counts = reconcileIdentitySnapshots(
      [legacy],
      [normalized, { ...normalized, id: 11 }],
      [channel, { ...channel, id: 21 }],
    );
    expect(counts.duplicate).toBe(2);
  });
});

describe("Telegram normalized registration boundary", () => {
  it("uses the atomic database function for legacy and normalized writes", async () => {
    const user = { id: 1, telegram_chat_id: 1001 };
    const single = vi.fn().mockResolvedValue({ data: user, error: null });
    const rpc = vi.fn().mockReturnValue({ single });
    const client = { rpc } as unknown as SupabaseClient;
    const service = new TelegramRegistrationService(new SupabaseNormalizedRegistrationRepository(client));

    await service.register({
      telegram_chat_id: 1001,
      telegram_username: "safe",
      telegram_first_name: "Safe",
    });

    expect(rpc).toHaveBeenCalledWith("register_telegram_identity", {
      p_telegram_chat_id: 1001,
      p_telegram_username: "safe",
      p_telegram_first_name: "Safe",
    });
  });

  it("propagates normalized synchronization failure instead of hiding partial state", async () => {
    const writer = { upsertTelegramRegistration: vi.fn().mockRejectedValue(new Error("normalized failure")) };
    await expect(new TelegramRegistrationService(writer).register({
      telegram_chat_id: 1001,
      telegram_username: null,
      telegram_first_name: null,
    })).rejects.toThrow("normalized failure");
  });
});
