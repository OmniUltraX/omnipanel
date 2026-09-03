import { describe, expect, it } from "vitest";
import { panelCandidateMatches, panelTabCreateSpec } from "./panelPlugin";
import { PLUGIN_ID_PANEL_1PANEL, PLUGIN_ID_PANEL_BT } from "./panelPlugin";
import { parsePluginManifest } from "@omnipanel/plugin-sdk";
import { setInstalledPluginManifests } from "../../../lib/pluginManifests";

describe("panelCandidateMatches", () => {
  const conn = (serviceType: string, sshId = "ssh-1") => ({
    kind: "panel",
    config: JSON.stringify({ sshConnectionId: sshId, serviceType }),
  });

  it("将 legacy 1panel 与插件 id 视为同一连接", () => {
    expect(
      panelCandidateMatches(conn("1panel"), {
        pluginId: PLUGIN_ID_PANEL_1PANEL,
        accountId: "ssh-1",
        remoteKind: "panel",
      }),
    ).toBe(true);
    expect(
      panelCandidateMatches(conn("onepanel"), {
        pluginId: PLUGIN_ID_PANEL_1PANEL,
        accountId: "ssh-1",
        remoteKind: "panel",
      }),
    ).toBe(true);
  });

  it("将 legacy bt/baota 与插件 id 视为同一连接", () => {
    expect(
      panelCandidateMatches(conn("bt"), {
        pluginId: PLUGIN_ID_PANEL_BT,
        accountId: "ssh-1",
        remoteKind: "panel",
      }),
    ).toBe(true);
    expect(
      panelCandidateMatches(conn("baota"), {
        pluginId: PLUGIN_ID_PANEL_BT,
        accountId: "ssh-1",
        remoteKind: "panel",
      }),
    ).toBe(true);
  });

  it("第三方 pluginId 原样匹配", () => {
    expect(
      panelCandidateMatches(conn("omni.panel.acme"), {
        pluginId: "omni.panel.acme",
        accountId: "ssh-1",
        remoteKind: "panel",
      }),
    ).toBe(true);
  });

  it("不同主机或不同面板不命中", () => {
    expect(
      panelCandidateMatches(conn("1panel", "ssh-2"), {
        pluginId: PLUGIN_ID_PANEL_1PANEL,
        accountId: "ssh-1",
        remoteKind: "panel",
      }),
    ).toBe(false);
    expect(
      panelCandidateMatches(conn("bt"), {
        pluginId: PLUGIN_ID_PANEL_1PANEL,
        accountId: "ssh-1",
        remoteKind: "panel",
      }),
    ).toBe(false);
  });
});

describe("panelTabCreateSpec", () => {
  it("第一方不走通用表单", () => {
    expect(panelTabCreateSpec("bt", "websites")).toBeNull();
    expect(panelTabCreateSpec("1panel", "websites")).toBeNull();
  });

  it("第三方声明 create + formFields 才点亮", () => {
    const manifest = parsePluginManifest({
      id: "omni.panel.acme",
      version: "0.1.0",
      kind: "panel",
      methods: [{ name: "createWebsite" }],
      contributes: {
        ui: {
          panelTabs: [
            {
              id: "websites",
              formFields: [{ key: "name", label: "名称" }],
              actions: [{ id: "create", method: "createWebsite", target: "toolbar" }],
            },
          ],
        },
      },
    });
    setInstalledPluginManifests([manifest]);
    expect(panelTabCreateSpec("omni.panel.acme", "websites")).toEqual({
      method: "createWebsite",
      formFields: [{ key: "name", label: "名称" }],
      label: undefined,
    });
    expect(panelTabCreateSpec("omni.panel.acme", "cronjobs")).toBeNull();
    setInstalledPluginManifests([]);
  });
});
