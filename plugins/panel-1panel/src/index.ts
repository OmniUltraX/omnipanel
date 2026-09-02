import { parsePluginManifest, definePlugin, type PluginManifest } from "@omnipanel/plugin-sdk";
import raw from "../plugin.json";
import {
  registerPanelProbeMapper,
  unregisterPanelProbeMappers,
} from "../../../frontend/src/lib/panelProbeRegistry";
import {
  registerPanelDriver,
  unregisterPanelDriver,
} from "../../../frontend/src/lib/panelDriverRegistry";
import { claimsOnePanelKind, PLUGIN_ID_PANEL_1PANEL, toOnePanelCandidate } from "./mapProbe";
import { onePanelDriver } from "./driver";

export const panel1PanelManifest: PluginManifest = parsePluginManifest(raw);

export default definePlugin({
  activate() {
    registerPanelProbeMapper({
      pluginId: PLUGIN_ID_PANEL_1PANEL,
      claims: claimsOnePanelKind,
      toCandidate: toOnePanelCandidate,
    });
    registerPanelDriver(PLUGIN_ID_PANEL_1PANEL, onePanelDriver);
  },
  deactivate() {
    unregisterPanelProbeMappers(PLUGIN_ID_PANEL_1PANEL);
    unregisterPanelDriver(PLUGIN_ID_PANEL_1PANEL);
  },
});
