import type { PluginManifest } from "@omnipanel/plugin-sdk";
import { parsePluginManifest } from "@omnipanel/plugin-sdk";
import raw from "../plugin.json";

export const panel1PanelManifest: PluginManifest = parsePluginManifest(raw);

export const PANEL_1PANEL_ALIASES = ["1panel", "omni.panel.1panel"] as const;

export const PANEL_1PANEL_CAPS = [
  "overview",
  "websites",
  "apps",
  "certificates",
  "cronjobs",
] as const;

export {
  claimsOnePanelKind,
  PANEL_PROBE_KIND_1PANEL,
  PLUGIN_ID_PANEL_1PANEL,
  toOnePanelCandidate,
} from "./mapProbe";
