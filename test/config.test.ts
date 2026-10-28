import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { getConfig } from "../src/config.ts";

describe("getConfig", () => {
  test("requires the API token", () => {
    assert.throws(() => getConfig({}), /^Error: CLEVER_CLOUD_API_TOKEN environment variable is required/);
    assert.throws(() => getConfig({ CLEVER_CLOUD_API_TOKEN: "  " }), /CLEVER_CLOUD_API_TOKEN/);
  });

  test("defaults the optional values, also when they are empty", () => {
    assert.deepEqual(getConfig({ CLEVER_CLOUD_API_TOKEN: "token", CC_MCP_TIMEOUT_MS: "" }), {
      apiToken: "token",
      executionTimeoutMs: 30_000,
      maxOutputLength: 50_000,
    });
  });

  test("reads the optional values", () => {
    const config = getConfig({ CLEVER_CLOUD_API_TOKEN: "token", CC_MCP_TIMEOUT_MS: "5000", CC_MCP_MAX_OUTPUT: "2000" });
    assert.equal(config.executionTimeoutMs, 5_000);
    assert.equal(config.maxOutputLength, 2_000);
  });

  for (const value of ["10abc", "1.5e4", "-5000", "500", "4294967296"]) {
    test(`rejects ${JSON.stringify(value)} as a timeout`, () => {
      assert.throws(
        () => getConfig({ CLEVER_CLOUD_API_TOKEN: "token", CC_MCP_TIMEOUT_MS: value }),
        new RegExp(`^Error: CC_MCP_TIMEOUT_MS must be an integer between 1000 and 2147483647, got "${value}"$`),
      );
    });
  }
});
