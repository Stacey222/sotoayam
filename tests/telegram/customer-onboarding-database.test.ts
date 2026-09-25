import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/auth/admin-password.js";
import { hashOpaqueToken } from "../../src/auth/admin-session.js";
import { startDisposablePostgresDatabase, type DisposablePostgresDatabase } from "../../scripts/check-clean-migrations.js";

let db: DisposablePostgresDatabase;
let ownerId = 0;
const scalar = async (sql: string) => (await db.query(sql))[0]!;

describe("P3-02 disposable PostgreSQL Telegram pairing", () => {
  beforeAll(async () => {
    db = await startDisposablePostgresDatabase("sotoayam-p302-");
    const hash = await hashPassword("0123456789abcdef");
    ownerId = Number((await db.query(`select user_id from public.provision_first_owner('Owner','owner@example.invalid',
      'scrypt','${hash}','OPERATIONS','Operations','Asia/Jakarta',300,
      '{"overdue":{"warningHours":1,"highHours":24,"criticalHours":72},"blocked":{"warningHours":4,"highHours":24,"criticalHours":72},"scheduler":{"staleMinutes":15,"criticalMinutes":60}}'::jsonb)`))[0]);
  }, 180_000);
  afterAll(async () => db?.close(), 30_000);

  it("fresh install has no Telegram identity before pairing", async () => {
    expect(await scalar("select (select count(*) from public.telegram_users)||'|'||(select count(*) from public.user_channels)"))
      .toBe("0|0");
  });

  it("consumes once, verifies the channel, rejects replay/duplicate, and creates seven preferences", async () => {
    const hash = hashOpaqueToken("a".repeat(43));
    await db.query(`select * from public.create_telegram_pairing(${ownerId},'${hash}',now()+interval '10 minutes')`);
    await db.query(`select id from public.consume_telegram_pairing('${hash}',987654,'owner_bot_user','Owner')`);
    expect(await scalar(`select u.legacy_telegram_user_id is not null||'|'||c.active||'|'||(c.verified_at is not null)::text||'|'
      ||(select count(*) from public.telegram_notification_preferences where telegram_user_id=u.legacy_telegram_user_id)
      from public.users u join public.user_channels c on c.user_id=u.id where u.id=${ownerId}`)).toBe("true|true|true|7");
    expect((await db.attempt(`select id from public.consume_telegram_pairing('${hash}',987654,'owner_bot_user','Owner')`)).error)
      .toContain("TELEGRAM_PAIRING_INVALID_OR_EXPIRED");
    const secondHash = hashOpaqueToken("b".repeat(43));
    expect((await db.attempt(`select * from public.create_telegram_pairing(${ownerId},'${secondHash}',now()+interval '10 minutes')`)).error)
      .toContain("TELEGRAM_ALREADY_CONNECTED");
  });

  it("rejects expired pairing without creating identity", async () => {
    const hash = hashOpaqueToken("c".repeat(43));
    await db.query(`insert into public.telegram_pairing_tokens(token_hash,user_id,expires_at,created_at)
      values('${hash}',${ownerId},now()-interval '1 second',now()-interval '2 seconds')`);
    expect((await db.attempt(`select id from public.consume_telegram_pairing('${hash}',111111,null,null)`)).error)
      .toContain("TELEGRAM_PAIRING_INVALID_OR_EXPIRED");
    expect(await scalar("select count(*) from public.telegram_users where telegram_chat_id=111111")).toBe("0");
  });

  it("updates all normalized preferences atomically through mirrored legacy columns", async () => {
    const rows = await db.query(`select notification_type||'='||enabled from public.update_own_telegram_preferences(
      ${ownerId},true,false,true,false,true,true,true)`);
    expect(rows).toHaveLength(7);
    expect(await scalar(`select count(*) from public.telegram_notification_preferences p join public.users u
      on u.legacy_telegram_user_id=p.telegram_user_id where u.id=${ownerId} and p.enabled`)).toBe("5");
    expect(await scalar(`select notification_preferences_reviewed_at is not null from public.user_channels where user_id=${ownerId}`)).toBe("t");
  });
});
