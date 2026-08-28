import { describe, expect, it } from "vitest";
import { hydrateConnectionGroup, normalizeConnectionGroup, type DbConnectionConfig } from "./api";
import { BUILTIN_DB_GROUPS, mergeBuiltinDbGroups } from "../../stores/dbGroupStore";

function sample(overrides: Partial<DbConnectionConfig> = {}): DbConnectionConfig {
  return {
    id: "manual",
    name: "manual",
    db_type: "mysql",
    host: "127.0.0.1",
    port: 3306,
    user: "root",
    password: "",
    database: "omni",
    ssl: false,
    group: "",
    status: "unknown",
    ...overrides,
  };
}

describe("hydrateConnectionGroup", () => {
  it("空分组归一为默认", () => {
    expect(hydrateConnectionGroup(sample()).group).toBe("默认");
    expect(normalizeConnectionGroup("default")).toBe("默认");
  });

  it("保留用户指定的分组", () => {
    expect(hydrateConnectionGroup(sample({ group: "测试" })).group).toBe("测试");
  });
});

describe("mergeBuiltinDbGroups", () => {
  it("给老 persist 补上缺失的内置组并保留自定义组", () => {
    const merged = mergeBuiltinDbGroups([
      { id: "default", name: "默认", builtin: true },
      { id: "custom", name: "项目 A" },
    ]);
    expect(merged.map((g) => g.id)).toEqual([...BUILTIN_DB_GROUPS.map((g) => g.id), "custom"]);
  });
});
