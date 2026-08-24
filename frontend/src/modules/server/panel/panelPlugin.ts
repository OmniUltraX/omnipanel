import { isPluginActivated, usePluginRuntimeStore } from "../../../stores/pluginRuntimeStore";
import {
  listPluginManifests,
  manifestPanelTabIds,
} from "../../../lib/pluginManifests";

export const PLUGIN_ID_PANEL_1PANEL = "omni.panel.1panel";
export const PLUGIN_ID_PANEL_BT = "omni.panel.bt";

export type PanelCapability =
  | "overview"
  | "websites"
  | "apps"
  | "certificates"
  | "cronjobs"
  | "databases";

const ALIASES: Record<string, string> = {
  bt: PLUGIN_ID_PANEL_BT,
  baota: PLUGIN_ID_PANEL_BT,
  [PLUGIN_ID_PANEL_BT]: PLUGIN_ID_PANEL_BT,
  "1panel": PLUGIN_ID_PANEL_1PANEL,
  onepanel: PLUGIN_ID_PANEL_1PANEL,
  [PLUGIN_ID_PANEL_1PANEL]: PLUGIN_ID_PANEL_1PANEL,
};

/** 面板能力来自 manifest `contributes.ui.panelTabs`（单源）。 */
const CAPS: Record<string, readonly PanelCapability[]> = Object.fromEntries(
  listPluginManifests("panel").map((manifest) => [
    manifest.id,
    manifestPanelTabIds(manifest) as PanelCapability[],
  ]),
);

export function canonicalPanelPluginId(serviceType: string | null | undefined): string {
  const raw = (serviceType ?? "").trim().toLowerCase();
  if (!raw) return PLUGIN_ID_PANEL_BT;
  return ALIASES[raw] ?? raw;
}

/** Host upsert 与预览层共用：legacy `1panel`/`bt` 与插件 id 等价。 */
export function panelCandidateMatches(
  conn: { kind?: string; config?: string | null },
  candidate: {
    pluginId: string;
    accountId?: string | null;
    remoteKind: string;
    config?: unknown;
  },
): boolean {
  if (conn.kind !== "panel" || candidate.remoteKind !== "panel") return false;
  let cfg: { sshConnectionId?: unknown; serviceType?: unknown } = {};
  try {
    cfg = JSON.parse(conn.config || "{}") as typeof cfg;
  } catch {
    return false;
  }
  const sshId =
    (typeof candidate.accountId === "string" && candidate.accountId) ||
    (candidate.config &&
    typeof candidate.config === "object" &&
    !Array.isArray(candidate.config) &&
    typeof (candidate.config as { sshConnectionId?: unknown }).sshConnectionId === "string"
      ? (candidate.config as { sshConnectionId: string }).sshConnectionId
      : "");
  if (!sshId || cfg.sshConnectionId !== sshId) return false;
  return canonicalPanelPluginId(typeof cfg.serviceType === "string" ? cfg.serviceType : "") ===
    canonicalPanelPluginId(candidate.pluginId);
}

/** 持久化用插件 id；读旧连接时把 bt/1panel 升格。 */
export function panelServiceTypeToPluginId(serviceType: string): string {
  return canonicalPanelPluginId(serviceType);
}

export function isOnePanelService(serviceType: string | null | undefined): boolean {
  return canonicalPanelPluginId(serviceType) === PLUGIN_ID_PANEL_1PANEL;
}

export function isBtPanelService(serviceType: string | null | undefined): boolean {
  return canonicalPanelPluginId(serviceType) === PLUGIN_ID_PANEL_BT;
}

export function panelHasCapability(
  serviceType: string | null | undefined,
  capability: PanelCapability,
): boolean {
  const id = canonicalPanelPluginId(serviceType);
  const hydrated = usePluginRuntimeStore.getState().hydrated;
  if (hydrated && !isPluginActivated(id)) return false;
  return CAPS[id]?.includes(capability) ?? false;
}

export function panelVendorLabelKey(serviceType: string | null | undefined): "bt" | "1panel" | "other" {
  if (isBtPanelService(serviceType)) return "bt";
  if (isOnePanelService(serviceType)) return "1panel";
  return "other";
}

/** i18n：`server.serviceType.bt` / `server.serviceType.1panel` */
export function panelServiceTypeI18nKey(serviceType: string | null | undefined): "bt" | "1panel" {
  return isOnePanelService(serviceType) ? "1panel" : "bt";
}
