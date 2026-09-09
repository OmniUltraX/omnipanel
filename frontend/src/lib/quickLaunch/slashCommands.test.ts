import { describe, expect, it } from "vitest";
import {
  buildSlashDashboardRows,
  buildSlashModelRows,
  matchSlashCatalog,
  parseSlashLaunchQuery,
} from "./slashCommands";
import type { AiModelProvider } from "../../stores/aiModelsStore";
import type { DashboardCatalogEntry } from "../dashboardCatalogSync";

function provider(partial: Partial<AiModelProvider> & Pick<AiModelProvider, "id" | "modelNames">): AiModelProvider {
  return {
    providerName: partial.providerName ?? "Test",
    apiStandard: partial.apiStandard ?? "openai",
    baseUrl: "https://api.example.com",
    apiKey: "",
    createdAt: 1,
    ...partial,
  };
}

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
  const providers: AiModelProvider[] = [
    provider({
      id: "p1",
      providerName: "OpenAI",
      modelNames: ["gpt-4o", "o1-mini"],
      disabledModelNames: ["o1-mini"],
    }),
    provider({
      id: "p2",
      providerName: "Anthropic",
      apiStandard: "anthropic",
      modelNames: ["claude-3-5-sonnet"],
    }),
  ];

  it("skips disabled models and fuzzy-filters", () => {
    const rows = buildSlashModelRows(providers, "gpt4", "p1::gpt-4o");
    expect(rows.map((r) => r.selectionId)).toEqual(["p1::gpt-4o"]);
    expect(rows[0]?.current).toBe(true);
  });

  it("matches provider name", () => {
    const rows = buildSlashModelRows(providers, "anthropic", null);
    expect(rows.map((r) => r.selectionId)).toEqual(["p2::claude-3-5-sonnet"]);
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
    expect(rows.map((r) => r.tabId)).toEqual(["board", "custom:1", "custom:2"]);
    expect(rows[0]?.current).toBe(true);
  });
});
