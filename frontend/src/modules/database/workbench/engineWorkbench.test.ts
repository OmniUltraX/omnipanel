import { describe, expect, it } from "vitest";
import { getEngineWorkbench } from "../engineRegistry";
import { parseEngineWorkbench } from "./engineWorkbench";

describe("parseEngineWorkbench", () => {
  it("reads redis kv slot", () => {
    expect(
      parseEngineWorkbench({
        tree: "kv",
        editor: "redis",
        preview: "key",
        connectionInfo: "redis",
      }),
    ).toEqual({
      tree: "kv",
      editor: "redis",
      preview: "key",
      connectionInfo: "redis",
    });
  });

  it("reads neo4j cypher and cassandra cql slots", () => {
    expect(
      parseEngineWorkbench({
        tree: "schema",
        editor: "cypher",
        preview: "grid",
        connectionInfo: "sql",
      })?.editor,
    ).toBe("cypher");
    expect(
      parseEngineWorkbench({
        tree: "schema",
        editor: "cql",
        preview: "grid",
        connectionInfo: "sql",
      })?.editor,
    ).toBe("cql");
  });

  it("returns null for empty object", () => {
    expect(parseEngineWorkbench({})).toBeNull();
  });
});

describe("getEngineWorkbench", () => {
  it("uses plugin contribution for redis / qdrant and sql default for mysql", () => {
    expect(getEngineWorkbench("redis").tree).toBe("kv");
    expect(getEngineWorkbench("qdrant").tree).toBe("collections");
    expect(getEngineWorkbench("clickhouse").editor).toBe("sql");
    expect(getEngineWorkbench("mysql").tree).toBe("schema");
    expect(getEngineWorkbench("mongodb").tree).toBe("documents");
  });
});
