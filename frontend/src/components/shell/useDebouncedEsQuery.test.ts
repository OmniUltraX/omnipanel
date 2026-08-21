import { describe, expect, it } from "vitest";
import { isEverythingUnavailableError } from "./useDebouncedEsQuery";

describe("isEverythingUnavailableError", () => {
  it("按 ErrorCode.connection 判定未运行", () => {
    expect(isEverythingUnavailableError({ code: "connection", message: "not running" })).toBe(
      true,
    );
    expect(isEverythingUnavailableError({ code: "internal", message: "boom" })).toBe(false);
    expect(isEverythingUnavailableError(new Error("not running"))).toBe(false);
  });
});
