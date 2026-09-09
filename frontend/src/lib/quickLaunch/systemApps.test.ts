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
  },
  {
    id: "d:\\apps\\notion.lnk",
    name: "Notion",
    path: "D:\\Apps\\Notion.lnk",
    source: "start-menu",
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
});
