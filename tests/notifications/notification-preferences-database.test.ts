import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDisposablePostgresDatabase, type DisposablePostgresDatabase } from "../../scripts/check-clean-migrations.js";

const types = ["STOCK_CRITICAL", "PURCHASE_RECOMMENDATION", "SALES_FOLLOWUP", "MARKETING_ALERT",
  "CONTENT_OPPORTUNITY", "OWNER_DAILY_REPORT", "SYSTEM_ERROR"] as const;
let db: DisposablePostgresDatabase;
let enabledId = 0; let defaultId = 0; let inactiveId = 0;
const scalar = async (sql: string) => (await db.query(sql))[0]!;
const mismatchCount = async () => Number(await scalar(`select count(*) from public.telegram_users tu
  cross join lateral (values
    ('STOCK_CRITICAL',tu.stock_alert),('PURCHASE_RECOMMENDATION',tu.purchase_alert),
    ('SALES_FOLLOWUP',tu.sales_alert),('MARKETING_ALERT',tu.marketing_alert),
    ('CONTENT_OPPORTUNITY',tu.content_alert),('OWNER_DAILY_REPORT',tu.owner_report),
    ('SYSTEM_ERROR',tu.system_error)) expected(notification_type,enabled)
  left join public.telegram_notification_preferences p on p.telegram_user_id=tu.id
    and p.notification_type=expected.notification_type
  where p.telegram_user_id is null or p.enabled is distinct from expected.enabled`));

describe("P2-03 disposable PostgreSQL preference normalization", () => {
  beforeAll(async () => {
    db = await startDisposablePostgresDatabase("sotoayam-p203-", 21);
    enabledId = Number(await scalar(`insert into public.telegram_users(telegram_chat_id,active,division,role,
      stock_alert,purchase_alert,sales_alert,marketing_alert,content_alert,owner_report,system_error)
      values(930001,true,'IT','Staff',true,false,true,false,true,false,true) returning id`));
    defaultId = Number(await scalar(`insert into public.telegram_users(telegram_chat_id,active,division,role)
      values(930002,true,'IT','Staff') returning id`));
    inactiveId = Number(await scalar(`insert into public.telegram_users(telegram_chat_id,active,division,role,stock_alert)
      values(930003,false,'IT','Staff',true) returning id`));
    const sql = await readFile("supabase/migrations/202609160001_normalize_telegram_notification_preferences.sql", "utf8");
    await db.query(sql);
  }, 180_000);
  afterAll(async () => db?.close(), 30_000);

  it("backfills exactly seven true/false values for each pre-existing row without duplicates", async () => {
    expect(await scalar(`select count(*) from public.telegram_notification_preferences`)).toBe("21");
    expect(await mismatchCount()).toBe(0);
    expect(await scalar(`select count(*) from (select telegram_user_id,notification_type,count(*)
      from public.telegram_notification_preferences group by 1,2 having count(*)>1) duplicate`)).toBe("0");
    expect(await scalar(`select count(*) from public.telegram_notification_preferences
      where telegram_user_id=${defaultId} and enabled`)).toBe("0");
    expect(await scalar(`select count(*) from public.telegram_notification_preferences
      where telegram_user_id=${enabledId} and enabled`)).toBe("4");
  });

  it("creates seven disabled rows for new registration and preserves opt-ins on repeat registration", async () => {
    const id = Number(await scalar(`select id from public.register_telegram_identity(930004,'test','Test')`));
    expect(await scalar(`select count(*) from public.telegram_notification_preferences where telegram_user_id=${id}`)).toBe("7");
    expect(await scalar(`select count(*) from public.telegram_notification_preferences where telegram_user_id=${id} and enabled`)).toBe("0");
    await db.query(`update public.telegram_users set stock_alert=true where id=${id}`);
    await db.query(`select id from public.register_telegram_identity(930004,'updated','Test')`);
    expect(await scalar(`select stock_alert from public.telegram_users where id=${id}`)).toBe("t");
    expect(await scalar(`select enabled from public.telegram_notification_preferences
      where telegram_user_id=${id} and notification_type='STOCK_CRITICAL'`)).toBe("t");
    expect(await mismatchCount()).toBe(0);
  });

  it("mirrors legacy updates atomically and rolls both sides back on a mirror failure", async () => {
    await db.query(`update public.telegram_users set purchase_alert=true,system_error=false where id=${enabledId}`);
    expect(await mismatchCount()).toBe(0);
    await db.query(`alter table public.telegram_notification_preferences add constraint p203_force_failure
      check (not (telegram_user_id=${defaultId} and notification_type='STOCK_CRITICAL' and enabled))`);
    const failed = await db.attempt(`update public.telegram_users set stock_alert=true where id=${defaultId}`);
    expect(failed.ok).toBe(false);
    expect(await scalar(`select stock_alert from public.telegram_users where id=${defaultId}`)).toBe("f");
    expect(await scalar(`select enabled from public.telegram_notification_preferences
      where telegram_user_id=${defaultId} and notification_type='STOCK_CRITICAL'`)).toBe("f");
    await db.query(`alter table public.telegram_notification_preferences drop constraint p203_force_failure`);
    expect(await mismatchCount()).toBe(0);
  });

  it("rejects arbitrary preference types and duplicate normalized keys", async () => {
    expect((await db.attempt(`insert into public.telegram_notification_preferences values(${defaultId},'CUSTOM',true)`)).ok).toBe(false);
    expect((await db.attempt(`insert into public.telegram_notification_preferences values(${defaultId},'STOCK_CRITICAL',true)`)).ok).toBe(false);
    expect((await db.attempt(`select id from public.find_shadow_notification_recipients('CUSTOM')`)).error).toContain("INVALID_NOTIFICATION_TYPE");
  });

  it("matches legacy active recipient sets for every one of the seven types", async () => {
    const columns = ["stock_alert", "purchase_alert", "sales_alert", "marketing_alert", "content_alert", "owner_report", "system_error"];
    for (const [index, type] of types.entries()) {
      const legacy = await db.query(`select id from public.telegram_users where active and ${columns[index]} order by id`);
      const normalized = await db.query(`select id from public.find_shadow_notification_recipients('${type}') order by id`);
      expect(normalized, type).toEqual(legacy);
    }
    expect(await scalar(`select count(*) from public.find_shadow_notification_recipients('STOCK_CRITICAL') where id=${inactiveId}`)).toBe("0");
    expect(await mismatchCount()).toBe(0);
  });

  it("keeps service-only access and deny-all RLS", async () => {
    expect(await scalar(`select relrowsecurity from pg_class where oid='public.telegram_notification_preferences'::regclass`)).toBe("t");
    expect(await scalar(`select has_table_privilege('anon','public.telegram_notification_preferences','select')
      or has_table_privilege('authenticated','public.telegram_notification_preferences','select')`)).toBe("f");
    expect(await scalar(`select has_function_privilege('service_role','public.find_shadow_notification_recipients(text)','execute')`)).toBe("t");
    expect(await scalar(`select has_function_privilege('anon','public.find_shadow_notification_recipients(text)','execute')`)).toBe("f");
  });
});
