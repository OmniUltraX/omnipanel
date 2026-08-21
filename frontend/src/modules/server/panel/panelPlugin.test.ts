import { describe, expect, it } from "vitest";
import { panelCandidateMatches } from "./panelPlugin";
import { PLUGIN_ID_PANEL_1PANEL, PLUGIN_ID_PANEL_BT } from "./panelPlugin";

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
