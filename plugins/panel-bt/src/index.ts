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
import { claimsBtPanelKind, PLUGIN_ID_PANEL_BT, toBtPanelCandidate } from "./mapProbe";
import { btPanelDriver } from "./driver";

export const panelBtManifest: PluginManifest = parsePluginManifest(raw);

export default definePlugin({
  activate() {
    registerPanelProbeMapper({
      pluginId: PLUGIN_ID_PANEL_BT,
      claims: claimsBtPanelKind,
      toCandidate: toBtPanelCandidate,
    });
    registerPanelDriver(PLUGIN_ID_PANEL_BT, btPanelDriver);
  },
  deactivate() {
    unregisterPanelProbeMappers(PLUGIN_ID_PANEL_BT);
    unregisterPanelDriver(PLUGIN_ID_PANEL_BT);
  },
});
