import { describe, expect, it } from "vitest";
import { getEngineIcon } from "./engineIcons";

describe("getEngineIcon", () => {
  it("returns logos for first-party and common DBX engines", () => {
    expect(getEngineIcon("sqlserver", "dark")).toBeTruthy();
    expect(getEngineIcon("oracle", "light")).toBeTruthy();
    expect(getEngineIcon("neo4j", "dark")).toBeTruthy();
    expect(getEngineIcon("cassandra", "dark")).toBeTruthy();
    expect(getEngineIcon("hive", "light")).toBeTruthy();
    expect(getEngineIcon("dameng", "dark")).toBeTruthy();
    expect(getEngineIcon("clickhouse", "light")).toBeTruthy();
    expect(getEngineIcon("firebird", "dark")).toBeTruthy();
  });

  it("falls back for unknown engines", () => {
    expect(getEngineIcon("not-a-real-engine", "dark")).toBeNull();
  });
});
