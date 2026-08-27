import { describe, expect, it } from "vitest";
import { getEngineWorkbench } from "../engineRegistry";
import { parseEngineWorkbench, isSchemaLikeTree } from "./engineWorkbench";

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
        tree: "graph",
        editor: "cypher",
        preview: "grid",
        connectionInfo: "sql",
      }),
    ).toEqual({
      tree: "graph",
      editor: "cypher",
      preview: "grid",
      connectionInfo: "sql",
    });
    expect(
      parseEngineWorkbench({
        tree: "keyspace",
        editor: "cql",
        preview: "grid",
        connectionInfo: "sql",
      }),
    ).toEqual({
      tree: "keyspace",
      editor: "cql",
      preview: "grid",
      connectionInfo: "sql",
    });
  });

  it("returns null for empty object", () => {
    expect(parseEngineWorkbench({})).toBeNull();
  });

  it("treats graph and keyspace as schema-like trees", () => {
    expect(isSchemaLikeTree("schema")).toBe(true);
    expect(isSchemaLikeTree("graph")).toBe(true);
    expect(isSchemaLikeTree("keyspace")).toBe(true);
    expect(isSchemaLikeTree("documents")).toBe(false);
    expect(isSchemaLikeTree("kv")).toBe(false);
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
