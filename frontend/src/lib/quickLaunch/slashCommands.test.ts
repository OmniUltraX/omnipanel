import { describe, expect, it } from "vitest";
import {
  buildSlashDashboardRows,
  buildSlashModelRows,
  matchSlashCatalog,
  parseSlashLaunchQuery,
} from "./slashCommands";
import type { DashboardCatalogEntry } from "../dashboardCatalogSync";

describe("parseSlashLaunchQuery", () => {
  it("returns null when not starting with /", () => {
    expect(parseSlashLaunchQuery("model")).toBeNull();
    expect(parseSlashLaunchQuery("ssh foo")).toBeNull();
  });

  it("parses bare / as catalog", () => {
    expect(parseSlashLaunchQuery("/")).toEqual({
      kind: "slash-catalog",
      raw: "/",
      filter: "",
    });
  });

  it("parses partial command as catalog filter", () => {
    expect(parseSlashLaunchQuery("/mo")).toEqual({
      kind: "slash-catalog",
      raw: "/mo",
      filter: "mo",
    });
  });

  it("parses /model and filter", () => {
    expect(parseSlashLaunchQuery("/model")).toEqual({
      kind: "slash-model",
      raw: "/model",
      filter: "",
    });
    expect(parseSlashLaunchQuery("/model gpt")).toEqual({
      kind: "slash-model",
      raw: "/model gpt",
      filter: "gpt",
    });
  });

  it("parses /dash and /dashboard", () => {
    expect(parseSlashLaunchQuery("/dash")).toEqual({
      kind: "slash-dashboard",
      raw: "/dash",
      filter: "",
    });
    expect(parseSlashLaunchQuery("/dashboard foo")).toEqual({
      kind: "slash-dashboard",
      raw: "/dashboard foo",
      filter: "foo",
    });
  });
});

describe("matchSlashCatalog", () => {
  it("lists model and dash; matches dashboard alias", () => {
    expect(matchSlashCatalog("").map((e) => e.id)).toEqual(["model", "dash"]);
    expect(matchSlashCatalog("mo").map((e) => e.id)).toEqual(["model"]);
    expect(matchSlashCatalog("dash").map((e) => e.id)).toEqual(["dash"]);
    expect(matchSlashCatalog("dashboard").map((e) => e.id)).toEqual(["dash"]);
    expect(matchSlashCatalog("zzz")).toEqual([]);
  });
});

describe("buildSlashModelRows", () => {
  const models = [
    { value: "cli:opencode::keep", label: "OpenCode/keep", subtitle: "智能体" },
    { value: "cli:opencode::other", label: "OpenCode/other", subtitle: "智能体" },
    { value: "cli:cursor::agent", label: "Cursor/agent", subtitle: "智能体" },
  ];

  it("fuzzy-filters by model label", () => {
    const rows = buildSlashModelRows(models, "keep", "cli:opencode::keep");
    expect(rows.map((r) => r.selectionId)).toEqual(["cli:opencode::keep"]);
    expect(rows[0]?.current).toBe(true);
  });

  it("matches subtitle", () => {
    const rows = buildSlashModelRows(models, "cursor", null);
    expect(rows.map((r) => r.selectionId)).toEqual(["cli:cursor::agent"]);
  });
});

describe("buildSlashDashboardRows", () => {
  const entries: DashboardCatalogEntry[] = [
    { tabId: "board", kind: "builtin" },
    { tabId: "custom:1", kind: "custom", label: "运维面板", widgetCount: 3 },
    { tabId: "custom:2", kind: "custom", label: "DB 监控", widgetCount: 1 },
  ];

  it("fuzzy filters and keeps board first", () => {
    const rows = buildSlashDashboardRows(
      entries,
      "运维",
      "custom:1",
      (e) => (e.kind === "builtin" ? "看板" : e.label ?? e.tabId),
    );
    expect(rows.map((r) => r.tabId)).toEqual(["custom:1"]);
    expect(rows[0]?.current).toBe(true);
  });

  it("lists all when filter empty", () => {
    const rows = buildSlashDashboardRows(entries, "", "board", (e) =>
      e.kind === "builtin" ? "看板" : e.label ?? e.tabId,
    );
    const ids = rows.map((r) => r.tabId);
    expect(ids[0]).toBe("board");
    expect(ids.sort()).toEqual(["board", "custom:1", "custom:2"]);
    expect(rows[0]?.current).toBe(true);
  });
});
