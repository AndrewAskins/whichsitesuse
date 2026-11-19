import { describe, expect, it } from "vitest";
import { missingR2Vars, r2ConfigError, r2Configured } from "../src/storage/r2.js";
import { testConfig } from "./helpers/config.js";

describe("R2 config", () => {
  const full = { R2_ACCOUNT_ID: "acct", R2_ACCESS_KEY_ID: "key", R2_SECRET_ACCESS_KEY: "secret" };

  it("is configured when all three are set", () => {
    expect(r2Configured({ ...testConfig(), ...full })).toBe(true);
  });

  it("treats blank values as missing and names them", () => {
    const config = { ...testConfig(), ...full, R2_SECRET_ACCESS_KEY: "  " };
    expect(missingR2Vars(config)).toEqual(["R2_SECRET_ACCESS_KEY"]);
    expect(r2Configured(config)).toBe(false);
  });

  it("names look-alike variables without their values", () => {
    const config = { ...testConfig(), R2_ACCOUNT_ID: "acct" };
    const err = r2ConfigError(config, { R2_ACCOUNT_ID: "acct", R2_ACCESS_KEY: "k", CLOUDFLARE_R2_SECRET: "s", PATH: "/bin" });
    expect(err.message).toBe(
      "R2 is not configured. Missing or blank: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY. Similar names that are set: CLOUDFLARE_R2_SECRET, R2_ACCESS_KEY.",
    );
    expect(err.message).not.toMatch(/\bk\b|\bs\b|acct/);
  });
});
