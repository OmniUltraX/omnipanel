import type { ImportCandidate } from "@omnipanel/plugin-sdk";

export const PLUGIN_ID_PANEL_1PANEL = "omni.panel.1panel";
export const PANEL_PROBE_KIND_1PANEL = "1panel";

export function claimsOnePanelKind(kind: string | null | undefined): boolean {
  const raw = (kind ?? "").trim().toLowerCase();
  return raw === "1panel" || raw === "onepanel" || raw === PLUGIN_ID_PANEL_1PANEL;
}

export function toOnePanelCandidate(input: {
  sshId: string;
  sshName: string;
  address: string;
  apiKey?: string;
  apiEnabled: boolean;
}): ImportCandidate {
  return {
    pluginId: PLUGIN_ID_PANEL_1PANEL,
    accountId: input.sshId,
    remoteId: `${input.sshId}:1panel`,
    remoteKind: "panel",
    name: `${input.sshName} · 1Panel`,
    config: {
      address: input.address,
      key: input.apiKey ?? "",
      serviceType: PLUGIN_ID_PANEL_1PANEL,
      sshConnectionId: input.sshId,
      probeKind: PANEL_PROBE_KIND_1PANEL,
      apiEnabled: input.apiEnabled,
    },
  };
}
