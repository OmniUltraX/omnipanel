import { describe, expect, it } from "vitest";
import {
  collectInsertColumnBindings,
  collectInsertColumnInlays,
  findInsertBindingAtValue,
  findInsertBindingsAtCursor,
} from "./insertColumnInlays";

function labelsAt(doc: string): Array<{ column: string; snippet: string }> {
  return collectInsertColumnInlays(doc).map((inlay) => ({
    column: inlay.column,
    snippet: doc.slice(inlay.from, Math.min(doc.length, inlay.from + 12)),
  }));
}

describe("collectInsertColumnInlays", () => {
  it("tags values in a single-row INSERT with column list", () => {
    const doc = "INSERT INTO t (id, name, age) VALUES (1, 'a', 18)";
    expect(labelsAt(doc)).toEqual([
      { column: "id", snippet: "1, 'a', 18)" },
      { column: "name", snippet: "'a', 18)" },
      { column: "age", snippet: "18)" },
    ]);
  });

  it("supports multiline VALUES like DataGrip", () => {
    const doc = `INSERT INTO infra_config (
  id, category, type, name
) VALUES (
  2, 'biz', 1, '用户管理'
);`;
    const labels = labelsAt(doc);
    expect(labels.map((l) => l.column)).toEqual(["id", "category", "type", "name"]);
    expect(labels[0]?.snippet.startsWith("2")).toBe(true);
    expect(labels[1]?.snippet.startsWith("'biz'")).toBe(true);
  });

  it("tags each row in multi-row VALUES", () => {
    const doc = "INSERT INTO t (a, b) VALUES (1, 2), (3, 4)";
    expect(labelsAt(doc).map((l) => l.column)).toEqual(["a", "b", "a", "b"]);
  });

  it("handles nested parens and commas inside values", () => {
    const doc = "INSERT INTO t (a, b) VALUES (func(1, 2), 'x,y')";
    const labels = labelsAt(doc);
    expect(labels.map((l) => l.column)).toEqual(["a", "b"]);
    expect(labels[0]?.snippet.startsWith("func(")).toBe(true);
    expect(labels[1]?.snippet.startsWith("'x,y'")).toBe(true);
  });

  it("strips identifier quotes from column tags", () => {
    const doc = "INSERT INTO t (`id`, \"name\") VALUES (1, 'x')";
    expect(labelsAt(doc).map((l) => l.column)).toEqual(["id", "name"]);
  });

  it("ignores INSERT without column list", () => {
    const doc = "INSERT INTO t VALUES (1, 2)";
    expect(collectInsertColumnInlays(doc)).toEqual([]);
  });

  it("supports INSERT IGNORE / OR REPLACE modifiers", () => {
    expect(
      labelsAt("INSERT IGNORE INTO t (id) VALUES (1)").map((l) => l.column),
    ).toEqual(["id"]);
    expect(
      labelsAt("INSERT OR REPLACE INTO t (id) VALUES (1)").map((l) => l.column),
    ).toEqual(["id"]);
  });

  it("ignores non-insert statements", () => {
    const doc = "SELECT id, name FROM t WHERE id = 1";
    expect(collectInsertColumnInlays(doc)).toEqual([]);
  });

  it("works across multiple statements", () => {
    const doc = "SELECT 1; INSERT INTO t (x) VALUES (9); SELECT 2;";
    const inlays = collectInsertColumnInlays(doc);
    expect(inlays).toHaveLength(1);
    expect(inlays[0]?.column).toBe("x");
    expect(doc[inlays[0]!.from]).toBe("9");
  });

  it("tags INSERT ... SELECT with backticks and WHERE NOT EXISTS", () => {
    expect(
      labelsAt("INSERT INTO `t` (`a`, `b`) SELECT 1, 2 WHERE NOT EXISTS (SELECT 1)").map(
        (l) => l.column,
      ),
    ).toEqual(["a", "b"]);
    expect(labelsAt("INSERT INTO `t` (`a`, `b`) VALUES (1, 2)").map((l) => l.column)).toEqual([
      "a",
      "b",
    ]);

    const doc = `INSERT INTO \`system_dict_type\` (\`name\`, \`type\`, \`status\`, \`remark\`, \`creator\`, \`create_time\`, \`updater\`, \`update_time\`, \`deleted\`)
SELECT 'AI TTS 提供商', 'ai_speech_tts_provider', 0, 'tongyi / stepfun', '1', NOW(), '1', NOW(), b'0'
WHERE NOT EXISTS (SELECT 1 FROM \`system_dict_type\` WHERE \`type\` = 'ai_speech_tts_provider');`;
    const labels = labelsAt(doc);
    expect(labels.map((l) => l.column)).toEqual([
      "name",
      "type",
      "status",
      "remark",
      "creator",
      "create_time",
      "updater",
      "update_time",
      "deleted",
    ]);
    expect(labels[0]?.snippet.startsWith("'AI TTS")).toBe(true);
    expect(labels[5]?.snippet.startsWith("NOW()")).toBe(true);
    expect(labels[8]?.snippet.startsWith("b'0'")).toBe(true);
  });

  it("stops SELECT list at FROM", () => {
    const doc = "INSERT INTO t (a, b) SELECT x, y FROM src WHERE a = 1";
    const labels = labelsAt(doc);
    expect(labels.map((l) => l.column)).toEqual(["a", "b"]);
    expect(labels[0]?.snippet.startsWith("x")).toBe(true);
    expect(labels[1]?.snippet.startsWith("y")).toBe(true);
  });
});

describe("insert column hover bindings", () => {
  it("maps value ranges to field spans", () => {
    const doc = "INSERT INTO t (id, name) VALUES (1, 'alice')";
    const bindings = collectInsertColumnBindings(doc);
    expect(bindings).toHaveLength(2);
    expect(doc.slice(bindings[0]!.fieldFrom, bindings[0]!.fieldTo)).toBe("id");
    expect(doc.slice(bindings[0]!.valueFrom, bindings[0]!.valueTo)).toBe("1");
    expect(doc.slice(bindings[1]!.fieldFrom, bindings[1]!.fieldTo)).toBe("name");
    expect(doc.slice(bindings[1]!.valueFrom, bindings[1]!.valueTo)).toBe("'alice'");
  });

  it("findInsertBindingAtValue resolves value at cursor", () => {
    const doc = "INSERT INTO t (id, name) VALUES (1, 'alice')";
    const bindings = collectInsertColumnBindings(doc);
    const nameValuePos = doc.indexOf("'alice'") + 2;
    const hit = findInsertBindingAtValue(bindings, nameValuePos);
    expect(hit?.column).toBe("name");
    expect(findInsertBindingAtValue(bindings, 0)).toBeNull();
  });

  it("findInsertBindingsAtCursor follows caret on value, field, and token end", () => {
    const doc = "INSERT INTO t (id, name) VALUES (1, 'alice')";
    const bindings = collectInsertColumnBindings(doc);
    const nameField = bindings[1]!;

    expect(findInsertBindingsAtCursor(bindings, doc.indexOf("'alice'") + 2).map((b) => b.column)).toEqual([
      "name",
    ]);
    expect(findInsertBindingsAtCursor(bindings, nameField.fieldFrom).map((b) => b.column)).toEqual(["name"]);
    expect(findInsertBindingsAtCursor(bindings, nameField.valueTo).map((b) => b.column)).toEqual(["name"]);
    expect(findInsertBindingsAtCursor(bindings, 0)).toEqual([]);
  });

  it("findInsertBindingsAtCursor highlights every row when caret is on a field", () => {
    const doc = "INSERT INTO t (a, b) VALUES (1, 2), (3, 4)";
    const bindings = collectInsertColumnBindings(doc);
    const fieldA = bindings[0]!;
    const hits = findInsertBindingsAtCursor(bindings, fieldA.fieldFrom);
    expect(hits.map((b) => doc.slice(b.valueFrom, b.valueTo))).toEqual(["1", "3"]);
  });

  it("works for INSERT SELECT seed style", () => {
    const doc = "INSERT INTO `t` (`name`, `type`) SELECT 'x', 'y' WHERE 1=1";
    const bindings = collectInsertColumnBindings(doc);
    expect(bindings.map((b) => b.column)).toEqual(["name", "type"]);
    expect(doc.slice(bindings[0]!.fieldFrom, bindings[0]!.fieldTo)).toBe("`name`");
    const hit = findInsertBindingAtValue(bindings, doc.indexOf("'y'") + 1);
    expect(hit?.column).toBe("type");
  });
});
