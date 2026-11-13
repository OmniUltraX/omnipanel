import { describe, expect, it } from "vitest";
import { buildDiffRows, diffLines, splitLines } from "./spaceConflictDiff";

describe("spaceConflictDiff", () => {
  it("相同正文逐行对齐", () => {
    const ops = diffLines(splitLines("a\nb\n"), splitLines("a\nb\n"));
    expect(ops.map((op) => op.type)).toEqual(["equal", "equal", "equal"]);
  });

  it("改一行时左右配成一对，并标出词", () => {
    const rows = buildDiffRows("name: old\nkeep\n", "name: new\nkeep\n");
    const edit = rows.find((row) => row.kind === "edit");
    expect(edit && edit.kind === "edit" ? edit.left.map((span) => span.text).join("") : "").toBe("name: old");
    expect(edit && edit.kind === "edit" ? edit.left.some((span) => span.mark && span.text.includes("old")) : false).toBe(true);
    expect(edit && edit.kind === "edit" ? edit.right.some((span) => span.mark && span.text.includes("new")) : false).toBe(true);
  });

  it("只在一边出现的行单独占一列", () => {
    const rows = buildDiffRows("only-current\nshared\n", "shared\nonly-saved\n");
    expect(rows.some((row) => row.kind === "del" && row.text === "only-current")).toBe(true);
    expect(rows.some((row) => row.kind === "add" && row.text === "only-saved")).toBe(true);
  });

  it("很长的正文仍能对上中间那一处改动", () => {
    const lines = Array.from({ length: 1200 }, (_, index) => `line ${index}`);
    const current = lines.join("\n");
    const savedLines = lines.slice();
    savedLines[400] = "line 400 changed";
    const rows = buildDiffRows(current, savedLines.join("\n"));
    expect(rows.some((row) => row.kind === "edit" && row.leftNo === 401)).toBe(true);
    expect(rows.some((row) => row.kind === "gap")).toBe(true);
  });

  it("大段未改动的行折叠起来", () => {
    const same = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
    const rows = buildDiffRows(`${same}\nchanged-a`, `${same}\nchanged-b`);
    const gap = rows.find((row) => row.kind === "gap");
    expect(gap && gap.kind === "gap" ? gap.count : 0).toBeGreaterThan(3);
  });
});
