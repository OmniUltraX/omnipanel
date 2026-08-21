import type { PluginManifest } from "@omnipanel/plugin-sdk";
import { parsePluginManifest } from "@omnipanel/plugin-sdk";
import raw from "../plugin.json";

export const warpgateImporterManifest: PluginManifest = parsePluginManifest(raw);
export {
  MOCK_WARPGATE_TARGETS,
  targetsToCandidates,
  WARPGATE_PLUGIN_ID,
  type WarpgateTarget,
} from "./mapTargets";
