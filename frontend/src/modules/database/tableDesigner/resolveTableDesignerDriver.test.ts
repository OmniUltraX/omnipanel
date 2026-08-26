import { describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({
  connectionHasTableSchemaChildren: () => true,
}));

import { supportsTableDesign } from "./resolveTableDesignerDriver";

describe("supportsTableDesign", () => {
  it("keeps first-party SQL engines", () => {
    expect(supportsTableDesign({ db_type: "mysql" })).toBe(true);
    expect(supportsTableDesign({ db_type: "postgresql" })).toBe(true);
    expect(supportsTableDesign({ db_type: "sqlite" })).toBe(true);
    expect(supportsTableDesign({ db_type: "sqlserver" })).toBe(true);
  });

  it("opens designer for SQL sidecar families", () => {
    expect(supportsTableDesign({ db_type: "oracle" })).toBe(true);
    expect(supportsTableDesign({ db_type: "dameng" })).toBe(true);
    expect(supportsTableDesign({ db_type: "kingbase" })).toBe(true);
    expect(supportsTableDesign({ db_type: "tidb" })).toBe(true);
    expect(supportsTableDesign({ db_type: "hive" })).toBe(true);
    expect(supportsTableDesign({ db_type: "firebird" })).toBe(true);
  });

  it("hides designer for non-SQL engines", () => {
    expect(supportsTableDesign({ db_type: "neo4j" })).toBe(false);
    expect(supportsTableDesign({ db_type: "cassandra" })).toBe(false);
    expect(supportsTableDesign({ db_type: "redis" })).toBe(false);
  });
});
