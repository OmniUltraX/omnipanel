import { describe, expect, it } from "vitest";
import { claimsOnePanelKind, toOnePanelCandidate } from "../../../plugins/panel-1panel/src/mapProbe";
import { claimsBtPanelKind, toBtPanelCandidate } from "../../../plugins/panel-bt/src/mapProbe";

describe("panel discovery mappers", () => {
  it("maps 1Panel probe to a candidate pointing at the panel plugin", () => {
    expect(claimsOnePanelKind("1panel")).toBe(true);
    const row = toOnePanelCandidate({
      sshId: "ssh-1",
      sshName: "web",
      address: "https://example.com:10086/entry",
      apiKey: "k",
      apiEnabled: true,
    });
    expect(row.pluginId).toBe("omni.panel.1panel");
    expect(row.remoteKind).toBe("panel");
    expect(row.remoteId).toBe("ssh-1:1panel");
    expect((row.config as { address: string }).address).toContain("example.com");
  });

  it("maps BT probe without using an internal IP as plugin identity", () => {
    expect(claimsBtPanelKind("bt")).toBe(true);
    const row = toBtPanelCandidate({
      sshId: "ssh-2",
      sshName: "db",
      address: "http://1.2.3.4:8888",
      apiEnabled: false,
    });
    expect(row.pluginId).toBe("omni.panel.bt");
    expect(row.accountId).toBe("ssh-2");
  });
});
