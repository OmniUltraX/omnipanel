import { parsePluginManifest, definePlugin, type PluginManifest } from "@omnipanel/plugin-sdk";
import raw from "../plugin.json";
import { registerImporterContribution, unregisterImporterContributions } from "../../../frontend/src/lib/importerContributionRegistry";
import { MOCK_WARPGATE_TARGETS, targetsToCandidates, WARPGATE_PLUGIN_ID } from "./mapTargets";

export const warpgateImporterManifest: PluginManifest = parsePluginManifest(raw);

/** 向导预览数据源：远程拉取落地前固定示例数据（sampleOnly 诚实标注）。 */
export default definePlugin({
  activate() {
    registerImporterContribution({
      id: "warpgate",
      pluginId: WARPGATE_PLUGIN_ID,
      getPreviewCandidates: () => targetsToCandidates("warpgate-mock", MOCK_WARPGATE_TARGETS),
      sampleOnly: true,
    });
  },
  deactivate() {
    unregisterImporterContributions(WARPGATE_PLUGIN_ID);
  },
});
