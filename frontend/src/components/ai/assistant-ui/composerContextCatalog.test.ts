import { describe, expect, it } from "vitest";
import { parseAtMention, stripAtMention } from "./composerContextCatalog";

describe("parseAtMention", () => {
  it("detects @ at start", () => {
    expect(parseAtMention("@p8", 3)).toEqual({ start: 0, query: "p8" });
  });

  it("detects @ after whitespace", () => {
    expect(parseAtMention("hello @term", 11)).toEqual({ start: 6, query: "term" });
  });

  it("returns null when not in mention", () => {
    expect(parseAtMention("hello", 5)).toBeNull();
    expect(parseAtMention("a@b", 3)).toBeNull();
  });

  it("strips mention range", () => {
    expect(stripAtMention("hello @term more", 6, 11).replace(/\s+/g, " ").trim()).toBe(
      "hello more",
    );
  });
});
