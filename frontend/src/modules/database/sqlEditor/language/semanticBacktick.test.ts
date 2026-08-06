import { describe, expect, it } from "vitest";
import {
  classifySemanticIdentifier,
  collectIdentifiersForTest,
  collectSemanticRangesForTest,
} from "./semantic";
import { Catalog } from "../catalog";
import { analyzeStatement } from "../parser/analyzer";

const SAMPLE_WITH_BACKTICK_ALIAS = `SELECT
    acm.id,
    acm.conversation_id,
    acm.reply_id,
    mu.mobile AS \`user_id\`,
    acm.role_id,
    acm.content,
    acm.extra_params
FROM ai_chat_message acm
LEFT JOIN member_user mu ON acm.user_id = mu.id
WHERE acm.tenant_id = 166`;

const SAMPLE_WITH_SINGLE_QUOTE_ALIAS = `SELECT
    acm.id,
    mu.mobile AS 'user_id',
    acm.role_id
FROM ai_chat_message acm
LEFT JOIN member_user mu ON acm.user_id = mu.id`;

const schemas = [
  {
    name: "db",
    tables: [
      {
        name: "ai_chat_message",
        columns: [
          { name: "id", type: "int" },
          { name: "conversation_id", type: "int" },
          { name: "reply_id", type: "int" },
          { name: "role_id", type: "int" },
          { name: "content", type: "text" },
          { name: "extra_params", type: "json" },
          { name: "user_id", type: "int" },
          { name: "tenant_id", type: "int" },
        ],
      },
      {
        name: "member_user",
        columns: [
          { name: "id", type: "int" },
          { name: "mobile", type: "varchar" },
        ],
      },
    ],
  },
];

describe("backtick identifier lexer", () => {
  it("continues scanning after AS `user_id`", () => {
    const tokens = collectIdentifiersForTest(SAMPLE_WITH_BACKTICK_ALIAS);
    const words = tokens.map((t) => t.word);

    expect(words).toContain("user_id");
    expect(words).toContain("role_id");
    expect(words).toContain("content");
    expect(words).toContain("ai_chat_message");
    expect(words).toContain("member_user");
    expect(words).toContain("tenant_id");
  });

  it("continues scanning after AS 'user_id'", () => {
    const tokens = collectIdentifiersForTest(SAMPLE_WITH_SINGLE_QUOTE_ALIAS);
    const words = tokens.map((t) => t.word);
    expect(words).toContain("role_id");
    expect(words).toContain("ai_chat_message");
  });

  it("highlights identifiers after backtick alias across the whole statement", () => {
    const ranges = collectSemanticRangesForTest(SAMPLE_WITH_BACKTICK_ALIAS, schemas, "mysql");
    const texts = ranges.map((r) => SAMPLE_WITH_BACKTICK_ALIAS.slice(r.from, r.to));

    expect(texts).toContain("role_id");
    expect(texts).toContain("ai_chat_message");
    expect(texts).toContain("member_user");
    expect(texts).toContain("tenant_id");

    const role = ranges.find((r) => SAMPLE_WITH_BACKTICK_ALIAS.slice(r.from, r.to) === "role_id");
    const table = ranges.find(
      (r) => SAMPLE_WITH_BACKTICK_ALIAS.slice(r.from, r.to) === "ai_chat_message",
    );
    const aliasAcm = ranges.filter(
      (r) => SAMPLE_WITH_BACKTICK_ALIAS.slice(r.from, r.to) === "acm" && r.kind === "alias",
    );

    expect(role?.kind).toBe("column");
    expect(table?.kind).toBe("table");
    expect(aliasAcm.length).toBeGreaterThan(3);
  });

  it("classifies acm.role_id after backtick alias", () => {
    const catalog = Catalog.fromSchemas(schemas);
    const analysis = analyzeStatement(SAMPLE_WITH_BACKTICK_ALIAS, "mysql");
    expect(classifySemanticIdentifier(catalog, analysis, "acm", null)).toBe("alias");
    expect(classifySemanticIdentifier(catalog, analysis, "role_id", "acm")).toBe("column");
    expect(classifySemanticIdentifier(catalog, analysis, "ai_chat_message", null)).toBe("table");
  });
});
