import { parsePluginManifest, definePlugin, type PluginManifest } from "@omnipanel/plugin-sdk";
import raw from "../plugin.json";

export const nacosModuleManifest: PluginManifest = parsePluginManifest(raw);

export const PLUGIN_ID_MODULE_NACOS = "omni.module.nacos";
export const NACOS_MODULE_KEY = "nacos";

/** 启动器前缀由 Host 按清单 `contributes.launcher` 差量登记；此处只占生命周期位。 */
export default definePlugin({
  activate() {
    return undefined;
  },
  deactivate() {
    return undefined;
  },
});
