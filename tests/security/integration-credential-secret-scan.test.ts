import { describe, expect, it } from "vitest";
import { findSecretPatternRules } from "../../scripts/check-secrets.js";

describe("P1-04 secret scanning", () => {
  it("P4-30 detects a Sotoayam integration credential", () => {
    const raw = `soto_${"ik"}_${"0".repeat(16)}_${"A".repeat(43)}`;
    expect(findSecretPatternRules(`leak=${raw}`)).toContain("SOTOAYAM_INTEGRATION_CREDENTIAL");
  });
});
