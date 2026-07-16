import { describe, expect, it } from "vitest";
import {
  formatDbWorkspaceTabLabel,
  makeConnectionScopedTabLabel,
  makeConnectionTabLabel,
  makeDatabaseListTabLabel,
  makeSqlTabLabel,
  makeTableDesignerTabLabel,
  makeTableTabLabel,
  makeTreeChartTabLabel,
} from "./workspaceTabs";

describe("formatDbWorkspaceTabLabel", () => {
  it("joins segments with @", () => {
    expect(
      formatDbWorkspaceTabLabel({
        table: "users",
        database: "app",
        connection: "本地",
      }),
    ).toBe("users@app@本地");
  });

  it("omits missing segments", () => {
    expect(
      formatDbWorkspaceTabLabel({
        action: "慢查询",
        connection: "本地",
      }),
    ).toBe("慢查询@本地");
    expect(
      formatDbWorkspaceTabLabel({
        database: "app",
        connection: "本地",
      }),
    ).toBe("app@本地");
    expect(formatDbWorkspaceTabLabel({ connection: "本地" })).toBe("本地");
  });
});

describe("typed tab label helpers", () => {
  it("matches product title rules", () => {
    expect(makeTableTabLabel("users", "mydb", "本地MySQL")).toBe(
      "users@mydb@本地MySQL",
    );
    expect(makeTableDesignerTabLabel("users", "mydb", "本地MySQL")).toBe(
      "users@mydb@本地MySQL",
    );
    expect(
      makeSqlTabLabel({
        table: "users",
        database: "mydb",
        connection: "本地MySQL",
      }),
    ).toBe("users@mydb@本地MySQL");
    expect(
      makeSqlTabLabel({
        action: "query1",
        database: "mydb",
        connection: "本地MySQL",
      }),
    ).toBe("query1@mydb@本地MySQL");
    expect(makeDatabaseListTabLabel("mydb", "本地MySQL")).toBe("mydb@本地MySQL");
    expect(makeConnectionTabLabel("本地MySQL")).toBe("本地MySQL");
    expect(makeConnectionScopedTabLabel("慢查询", "本地MySQL")).toBe(
      "慢查询@本地MySQL",
    );
    expect(makeConnectionScopedTabLabel("二进制", "本地MySQL")).toBe(
      "二进制@本地MySQL",
    );
    expect(makeTreeChartTabLabel("树图", "文件名")).toBe("树图@文件名");
  });
});
