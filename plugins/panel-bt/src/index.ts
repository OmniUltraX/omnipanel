import type { PluginManifest } from "@omnipanel/plugin-sdk";
import { parsePluginManifest } from "@omnipanel/plugin-sdk";
import raw from "../plugin.json";

export const panelBtManifest: PluginManifest = parsePluginManifest(raw);

export const PANEL_BT_CAPS = [
  "overview",
  "websites",
  "apps",
  "certificates",
  "cronjobs",
  "databases",
] as const;

export {
  claimsBtPanelKind,
  PANEL_PROBE_KIND_BT,
  PLUGIN_ID_PANEL_BT,
  toBtPanelCandidate,
} from "./mapProbe";
