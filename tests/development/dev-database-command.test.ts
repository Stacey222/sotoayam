import { describe, expect, it } from "vitest";
import {
  assertDevelopmentExecutionContext,
  validateDevelopmentDatabaseUrl,
} from "../../scripts/dev-database-command.js";

const ref = "abcdefghijklmnopqrst";
const poolerHost = "aws-0-ap-northeast-2.pooler.supabase.com";
const linkedPooler = `postgresql://postgres.${ref}@${poolerHost}:5432/postgres`;
const password = "test-password";

describe("development database target validation", () => {
  it("accepts the exact same-project Direct connection", () => {
    const target = validateDevelopmentDatabaseUrl(
      `postgresql://postgres:${password}@db.${ref}.supabase.co:5432/postgres`, ref, linkedPooler);
    expect(target).toMatchObject({ hostname: `db.${ref}.supabase.co`, mode: "DIRECT", password });
    expect(target.connectionUrl).toContain("sslmode=require");
    expect(target.connectionUrl).not.toContain(password);
  });

  it("accepts the linked same-project Session Pooler", () => {
    const target = validateDevelopmentDatabaseUrl(
      `postgresql://postgres.${ref}:${password}@${poolerHost}:5432/postgres?sslmode=require`, ref, linkedPooler);
    expect(target).toMatchObject({ hostname: poolerHost, mode: "SESSION_POOLER", password });
    expect(target.connectionUrl).not.toContain(password);
  });

  it("rejects a different-project pooler username", () => {
    expect(() => validateDevelopmentDatabaseUrl(
      `postgresql://postgres.differentprojectref:${password}@${poolerHost}:5432/postgres`, ref, linkedPooler))
      .toThrow(/does not match/);
  });

  it("rejects an arbitrary pooler host even with the correct project username", () => {
    expect(() => validateDevelopmentDatabaseUrl(
      `postgresql://postgres.${ref}:${password}@aws-0-other.pooler.supabase.com:5432/postgres`, ref, linkedPooler))
      .toThrow(/does not match/);
  });

  it("rejects transaction pooler and unsafe connection formats", () => {
    expect(() => validateDevelopmentDatabaseUrl(
      `postgresql://postgres.${ref}:${password}@${poolerHost}:6543/postgres`, ref, linkedPooler))
      .toThrow(/approved Supabase/);
    expect(() => validateDevelopmentDatabaseUrl(
      `postgresql://postgres.${ref}:${password}@${poolerHost}:5432/other`, ref, linkedPooler))
      .toThrow(/approved Supabase/);
    expect(() => validateDevelopmentDatabaseUrl(
      `postgresql://postgres.${ref}:${password}@${poolerHost}:5432/postgres?options=-cstatement_timeout=0`, ref,
      linkedPooler)).toThrow(/unsupported connection options/);
  });

  it("keeps the production guard fail closed", () => {
    expect(() => assertDevelopmentExecutionContext({
      NODE_ENV: "production",
      SOTOAYAM_DEV_TARGET: "development",
      SOTOAYAM_EXPECTED_DEV_PROJECT_REF: ref,
      RESET_CONFIRMATION: "RESET",
    }, ref, "RESET_CONFIRMATION", "RESET")).toThrow("Production environment refused");
  });
});
