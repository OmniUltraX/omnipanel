import { parsePluginManifest, definePlugin, type PluginManifest } from "@omnipanel/plugin-sdk";
import raw from "../plugin.json";
import {
  registerPanelProbeMapper,
  unregisterPanelProbeMappers,
} from "../../../frontend/src/lib/panelProbeRegistry";
import { claimsBtPanelKind, PLUGIN_ID_PANEL_BT, toBtPanelCandidate } from "./mapProbe";

export const panelBtManifest: PluginManifest = parsePluginManifest(raw);

export default definePlugin({
  activate() {
    registerPanelProbeMapper({
      pluginId: PLUGIN_ID_PANEL_BT,
      claims: claimsBtPanelKind,
      toCandidate: toBtPanelCandidate,
    });
  },
  deactivate() {
    unregisterPanelProbeMappers(PLUGIN_ID_PANEL_BT);
  },
});
