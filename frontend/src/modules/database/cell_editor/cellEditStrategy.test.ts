import { describe, expect, it } from "vitest";
import { resolveCellDoubleClickEditStrategy } from "./types";

describe("resolveCellDoubleClickEditStrategy", () => {
  it("uses inline for boolean and date types", () => {
    expect(resolveCellDoubleClickEditStrategy("tinyint(1)", false)).toBe("inline");
    expect(resolveCellDoubleClickEditStrategy("date", "2024-01-01")).toBe("inline");
    expect(resolveCellDoubleClickEditStrategy("datetime", "2024-01-01 12:00:00")).toBe("inline");
  });

  it("uses inline for text and json", () => {
    expect(resolveCellDoubleClickEditStrategy("text", "hello")).toBe("inline");
    expect(resolveCellDoubleClickEditStrategy("json", '{"a":1}')).toBe("inline");
  });

  it("uses preview for image/audio blob", () => {
    expect(
      resolveCellDoubleClickEditStrategy("blob", {
        __omni: "blob",
        size: 10,
        kind: "image",
        mime: "image/png",
      }),
    ).toBe("preview");
    expect(
      resolveCellDoubleClickEditStrategy("blob", {
        __omni: "blob",
        size: 10,
        kind: "audio",
        mime: "audio/mpeg",
      }),
    ).toBe("preview");
  });

  it("uses panel for binary blob without media", () => {
    expect(
      resolveCellDoubleClickEditStrategy("blob", {
        __omni: "blob",
        size: 10,
        kind: "binary",
      }),
    ).toBe("panel");
  });
});
