import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migration = path.resolve("supabase/migrations/202609120001_create_telegram_polling_state.sql");

describe("P1-05 migration contract", () => {
  it("P5-21 adds exactly one eighteenth migration without altering existing tables", async () => {
    const names = (await readdir(path.resolve("supabase/migrations"))).filter((name) => name.endsWith(".sql")).sort();
    expect(names).toHaveLength(18);
    expect(names.at(-1)).toBe("202609120001_create_telegram_polling_state.sql");
    const sql = await readFile(migration, "utf8");
    expect(sql).not.toMatch(/alter\s+table\s+public\.(?!telegram_polling_state|telegram_processed_updates)/i);
    expect(sql).not.toMatch(/drop\s+(?:table|column)|truncate\s|delete\s+from\s+public\.(?!telegram_processed_updates)/i);
  });

  it("creates RPC-only polling state with atomic completion and a PROCESSING clamp", async () => {
    const sql = await readFile(migration, "utf8");
    expect(sql).toContain("create table public.telegram_polling_state");
    expect(sql).toContain("create table public.telegram_processed_updates");
    expect(sql).toContain("create function public.complete_telegram_update");
    expect(sql).toContain("select min(updates.update_id) into blocking");
    expect(sql).toContain("candidate := least(candidate, blocking)");
    expect(sql).toContain("next_offset = greatest(polling.next_offset, candidate)");
    expect(sql).toMatch(/revoke all on table public\.telegram_polling_state from public, anon, authenticated, service_role/);
    expect(sql).toMatch(/revoke all on table public\.telegram_processed_updates from public, anon, authenticated, service_role/);
  });

  it("stores only bookkeeping metadata and no Telegram content or identity", async () => {
    const sql = await readFile(migration, "utf8");
    const table = sql.slice(sql.indexOf("create table public.telegram_processed_updates"),
      sql.indexOf("create index telegram_processed_updates_prune_idx"));
    expect(table).not.toMatch(/\b(?:message|caption|username|first_name)\s+text|chat_id|user_id/i);
    expect(table).toMatch(/update_id bigint primary key/);
    expect(table).toMatch(/failure_class text/);
  });
});
