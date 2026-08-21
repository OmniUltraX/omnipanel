import type { Connection, PanelProbeItem } from "../ipc/bindings";
import type { DiscoveryPreviewRow } from "../components/ui/DiscoveryImportDialog";
import { isPluginActivated } from "../stores/pluginRuntimeStore";
import {
  claimsOnePanelKind,
  toOnePanelCandidate,
  PLUGIN_ID_PANEL_1PANEL,
} from "../../../plugins/panel-1panel/src/mapProbe";
import {
  claimsBtPanelKind,
  toBtPanelCandidate,
  PLUGIN_ID_PANEL_BT,
} from "../../../plugins/panel-bt/src/mapProbe";
import { panelCandidateMatches } from "../modules/server/panel/panelPlugin";

function mapperForKind(kind: string) {
  if (claimsOnePanelKind(kind)) {
    return {
      pluginId: PLUGIN_ID_PANEL_1PANEL,
      toCandidate: toOnePanelCandidate,
    };
  }
  if (claimsBtPanelKind(kind)) {
    return {
      pluginId: PLUGIN_ID_PANEL_BT,
      toCandidate: toBtPanelCandidate,
    };
  }
  return null;
}

function existingPanel(
  connections: Connection[],
  sshId: string,
  pluginId: string,
): Connection | undefined {
  return connections.find((conn) =>
    panelCandidateMatches(conn, {
      pluginId,
      accountId: sshId,
      remoteKind: "panel",
    }),
  );
}

export function panelProbeToPreviewRow(input: {
  ssh: Connection;
  panel: PanelProbeItem;
  address: string;
  connections: Connection[];
}): DiscoveryPreviewRow | null {
  if (!input.panel.installed) return null;
  const mapper = mapperForKind(input.panel.kind);
  const pluginId = mapper?.pluginId ?? `omni.panel.${input.panel.kind}`;
  const activated = isPluginActivated(pluginId);
  const candidate = mapper
    ? mapper.toCandidate({
        sshId: input.ssh.id,
        sshName: input.ssh.name,
        address: input.address,
        apiKey: input.panel.apiKey,
        apiEnabled: input.panel.apiEnabled,
      })
    : {
        pluginId,
        accountId: input.ssh.id,
        remoteId: `${input.ssh.id}:${input.panel.kind}`,
        remoteKind: "panel" as const,
        name: `${input.ssh.name} · ${input.panel.kind}`,
        config: { address: input.address, sshConnectionId: input.ssh.id },
      };
  const duplicate = Boolean(existingPanel(input.connections, input.ssh.id, pluginId));
  const unsupported = !mapper || !activated;
  const status = unsupported ? "unsupported" : duplicate ? "duplicate" : "importable";
  return {
    id: candidate.remoteId,
    candidate,
    label: candidate.name,
    kindLabel: input.panel.kind,
    host: input.address,
    status,
    disabled: unsupported,
  };
}
