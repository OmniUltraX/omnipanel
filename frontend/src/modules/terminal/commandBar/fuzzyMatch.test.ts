import { describe, expect, it } from "vitest";
import { fuzzyMatches, fuzzyMatchScore, fuzzyHighlightIndices } from "./fuzzyMatch";

describe("fuzzyMatch", () => {
  it("matches path initials with one skipped query char", () => {
    expect(fuzzyMatches("cnpm", "cd /dev/prod/m")).toBe(true);
    expect(fuzzyMatches("cdpm", "cd /dev/prod/m")).toBe(true);
  });

  it("matches collapsed query across non-adjacent chars", () => {
    expect(fuzzyMatches("cnpm", "cd /dev/prod/npm")).toBe(true);
    expect(fuzzyMatches("cargo", "cargo build -p findx2")).toBe(true);
  });

  it("does not match when chars are out of order", () => {
    expect(fuzzyMatches("mcp", "cd /dev/prod/m")).toBe(false);
  });

  it("ranks closer matches higher", () => {
    const exact = fuzzyMatchScore("cargo", "cargo build");
    const loose = fuzzyMatchScore("cargo", "cd /dev/prod/npm");
    expect(exact).toBeGreaterThan(loose);
  });

  it("ranks prefix matches above mid-string hits", () => {
    expect(fuzzyMatchScore("a", "apps")).toBeGreaterThan(fuzzyMatchScore("a", "cloudcanal_home"));
    expect(fuzzyMatchScore("con", "containerd")).toBeGreaterThan(
      fuzzyMatchScore("con", "cloudcanal_home"),
    );
  });

  it("highlights matched characters for path initials", () => {
    const indices = fuzzyHighlightIndices("cnpm", "cd /dev/prod/m");
    expect(indices).toContain(0);
    expect(indices.length).toBeGreaterThan(0);
  });
});
