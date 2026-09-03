import { describe, expect, it } from "vitest";
import {
  findModuleTabId,
  makeModuleTabId,
  openOrFocusModuleTab,
  type ModuleWorkspaceTab,
} from "./moduleWorkspaceTabs";

function tab(
  partial: Pick<ModuleWorkspaceTab, "connectionId" | "capabilityId"> &
    Partial<ModuleWorkspaceTab>,
): ModuleWorkspaceTab {
  const moduleKey = partial.moduleKey ?? "nacos";
  const capabilityId = partial.capabilityId;
  return {
    id: partial.id ?? makeModuleTabId(moduleKey, partial.connectionId, capabilityId),
    moduleKey,
    connectionId: partial.connectionId,
    capabilityId,
    preview: partial.preview,
  };
}

describe("module workspace tabs", () => {
  it("单击预览会替换已有 preview Tab", () => {
    const opened = openOrFocusModuleTab(
      [tab({ connectionId: "a", capabilityId: "overview", preview: true })],
      "module:nacos:a:overview",
      "preview",
      undefined,
      (id, preview) =>
        tab({
          id: id || makeModuleTabId("nacos", "b", "config"),
          connectionId: "b",
          capabilityId: "config",
          preview,
        }),
    );
    expect(opened.tabs).toHaveLength(1);
    expect(opened.tabs[0]?.capabilityId).toBe("config");
    expect(opened.tabs[0]?.preview).toBe(true);
  });

  it("双击会把已有 Tab 钉成常驻", () => {
    const existing = tab({ connectionId: "a", capabilityId: "config", preview: true });
    const opened = openOrFocusModuleTab(
      [existing],
      existing.id,
      "permanent",
      existing.id,
      (id, preview) => tab({ id: id || existing.id, connectionId: "a", capabilityId: "config", preview }),
    );
    expect(opened.tabs[0]?.preview).toBe(false);
    expect(findModuleTabId(opened.tabs, "nacos", "a", "config")).toBe(existing.id);
  });
});
