import type { ImportCandidate } from "@omnipanel/plugin-sdk";

export const PLUGIN_ID_PANEL_BT = "omni.panel.bt";
export const PANEL_PROBE_KIND_BT = "bt";

export function claimsBtPanelKind(kind: string | null | undefined): boolean {
  const raw = (kind ?? "").trim().toLowerCase();
  return raw === "bt" || raw === "baota" || raw === PLUGIN_ID_PANEL_BT;
}

export function toBtPanelCandidate(input: {
  sshId: string;
  sshName: string;
  address: string;
  apiKey?: string;
  apiEnabled: boolean;
}): ImportCandidate {
  return {
    pluginId: PLUGIN_ID_PANEL_BT,
    accountId: input.sshId,
    remoteId: `${input.sshId}:bt`,
    remoteKind: "panel",
    name: `${input.sshName} · 宝塔`,
    config: {
      address: input.address,
      key: input.apiKey ?? "",
      serviceType: PLUGIN_ID_PANEL_BT,
      sshConnectionId: input.sshId,
      probeKind: PANEL_PROBE_KIND_BT,
      apiEnabled: input.apiEnabled,
    },
  };
}
