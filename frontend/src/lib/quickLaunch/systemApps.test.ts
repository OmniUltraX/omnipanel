import { describe, expect, it } from "vitest";
import { matchSystemApps, type SystemAppEntry } from "./systemApps";

const sample: SystemAppEntry[] = [
  {
    id: "c:\\windows\\system32\\notepad.exe",
    name: "notepad",
    path: "C:\\Windows\\System32\\notepad.exe",
    source: "app-paths",
  },
  {
    id: "c:\\windows\\system32\\calc.exe",
    name: "Calculator",
    path: "C:\\Windows\\System32\\calc.exe",
    source: "app-paths",
    aliases: ["calc"],
  },
  {
    id: "d:\\apps\\notion.lnk",
    name: "Notion",
    path: "D:\\Apps\\Notion.lnk",
    source: "start-menu",
  },
  {
    id: "c:\\programdata\\...\\计算器.lnk",
    name: "计算器",
    path: "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\计算器.lnk",
    source: "start-menu",
    aliases: ["calc", "calculator"],
  },
];

describe("matchSystemApps", () => {
  it("matches notepad by note prefix", () => {
    const rows = matchSystemApps(sample, "note");
    expect(rows.some((r) => r.type === "system-app" && r.label === "notepad")).toBe(
      true,
    );
  });

  it("returns empty for blank filter", () => {
    expect(matchSystemApps(sample, "  ")).toEqual([]);
  });

  it("ranks exact name highest", () => {
    const rows = matchSystemApps(sample, "notepad");
    expect(rows[0]?.label).toBe("notepad");
    expect(rows[0]?.score).toBe(100);
  });

  it("matches 计算器 via calc alias", () => {
    const rows = matchSystemApps(sample, "calc");
    expect(rows.some((r) => r.type === "system-app" && r.label === "计算器")).toBe(
      true,
    );
  });
});
