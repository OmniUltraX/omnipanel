import { parsePluginManifest, definePlugin, type PluginManifest } from "@omnipanel/plugin-sdk";
import raw from "../plugin.json";
import {
  registerPanelProbeMapper,
  unregisterPanelProbeMappers,
} from "../../../frontend/src/lib/panelProbeRegistry";
import { claimsOnePanelKind, PLUGIN_ID_PANEL_1PANEL, toOnePanelCandidate } from "./mapProbe";

export const panel1PanelManifest: PluginManifest = parsePluginManifest(raw);

export default definePlugin({
  activate() {
    registerPanelProbeMapper({
      pluginId: PLUGIN_ID_PANEL_1PANEL,
      claims: claimsOnePanelKind,
      toCandidate: toOnePanelCandidate,
    });
  },
  deactivate() {
    unregisterPanelProbeMappers(PLUGIN_ID_PANEL_1PANEL);
  },
});
