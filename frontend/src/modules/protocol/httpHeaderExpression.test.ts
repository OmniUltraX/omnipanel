import { describe, expect, it } from "vitest";
import { evaluateHeaderExpression } from "./httpHeaderExpression";

describe("evaluateHeaderExpression", () => {
  it("concatenates string and unix_timestamp", async () => {
    const result = await evaluateHeaderExpression("'1panel:' + unix_timestamp", {
      nowMs: 1_700_000_000_000,
    });
    expect(result).toBe("1panel:1700000000");
  });

  it("computes hmac_sha256 hex digest", async () => {
    const result = await evaluateHeaderExpression("hmac_sha256('secret', 'hello')");
    expect(result).toBe("88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b");
  });

  it("supports nested expression in hmac args", async () => {
    const message = await evaluateHeaderExpression("'1panel:' + unix_timestamp", {
      nowMs: 1_700_000_000_000,
    });
    const result = await evaluateHeaderExpression(
      "hmac_sha256('xxx', '1panel:' + unix_timestamp)",
      { nowMs: 1_700_000_000_000 },
    );
    const expected = await evaluateHeaderExpression(`hmac_sha256('xxx', '${message}')`, {
      nowMs: 1_700_000_000_000,
    });
    expect(result).toBe(expected);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects unknown function", async () => {
    await expect(evaluateHeaderExpression("unknown('a')")).rejects.toThrow("未知函数");
  });
});
