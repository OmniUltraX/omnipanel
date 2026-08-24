import type { CloudResourceTab } from "../server/cloud/cloudSidebarNav";
import { resolveLegacyPluginId, getPluginManifest, manifestPanelTabIds } from "../../lib/pluginManifests";

/** 云产品 Tab 来自 manifest `contributes.ui.panelTabs`（单源）。 */
export function cloudTabsForProvider(provider: string | null | undefined): CloudResourceTab[] {
  const pluginId = resolveLegacyPluginId(provider);
  if (!pluginId) return [];
  const manifest = getPluginManifest(pluginId);
  if (manifest?.kind !== "cloud") return [];
  return manifestPanelTabIds(manifest) as CloudResourceTab[];
}
