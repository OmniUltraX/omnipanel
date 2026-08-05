import { describe, expect, it } from "vitest";
import { parseAtMention, stripAtMention, filterComposerContextOptions } from "./composerContextCatalog";
import type { ComposerContextCatalog } from "./composerContextCatalog";

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

describe("filterComposerContextOptions", () => {
  const catalog: ComposerContextCatalog = {
    terminal: [],
    ssh: [],
    database: [
      {
        kind: "database",
        id: "db-1",
        label: "orders-mysql",
        subtitle: "mysql · 127.0.0.1:3306",
        disabled: false,
      },
    ],
    docker: [],
  };

  it("matches database by label", () => {
    const hits = filterComposerContextOptions(catalog, "orders");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe("db-1");
  });

  it("matches database by subtitle host", () => {
    const hits = filterComposerContextOptions(catalog, "127.0.0.1");
    expect(hits).toHaveLength(1);
  });
});
