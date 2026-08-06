import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";
import { createSqlCompletionSource } from "../sqlEditor/language/autocomplete";
import { buildDatabaseSchema } from "../sqlEditor/language/completionItems";
import type { DatabaseSchema } from "../types";

const schemas: DatabaseSchema[] = [
  buildDatabaseSchema("demo", [
    {
      name: "users",
      columns: [
        { name: "id", type: "int" },
        { name: "name", type: "varchar" },
        { name: "email", type: "varchar" },
      ],
    },
  ]),
];

describe("table dot all-columns completion", () => {
  it("puts comma-joined columns as the first option after table.", async () => {
    const sql = "SELECT users.";
    const state = EditorState.create({ doc: sql });
    const source = createSqlCompletionSource(() => schemas);
    const context = new CompletionContext(state, sql.length, true);
    const result = await source(context);
    expect(result).not.toBeNull();
    expect(result!.options[0]?.label).toBe("id, name, email");
    expect(String(result!.options[0]?.detail ?? "")).toContain("全部字段");
  });

  it("hides all-columns item when filtering by column prefix", async () => {
    const sql = "SELECT users.id";
    const state = EditorState.create({ doc: sql });
    const source = createSqlCompletionSource(() => schemas);
    const context = new CompletionContext(state, sql.length, true);
    const result = await source(context);
    expect(result).not.toBeNull();
    const details = result!.options.map((item) => String(item.detail ?? ""));
    expect(details.some((detail) => detail.includes("全部字段"))).toBe(false);
  });
});
