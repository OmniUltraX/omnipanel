import { parsePluginManifest, definePlugin, type PluginManifest } from "@omnipanel/plugin-sdk";
import raw from "../plugin.json";
import {
  registerLauncherProvider,
  unregisterLauncherProvider,
} from "../../../frontend/src/lib/quickLauncherMatch";

export const everythingAddonManifest: PluginManifest = parsePluginManifest(raw);
export const EVERYTHING_LAUNCHER_PREFIX = "es";
export const EVERYTHING_TOOL_NAME = "omni_everything_search";

/** 启动器 es 前缀：随插件启用状态登记/卸除（内核 ssh/db 不受影响）。 */
export default definePlugin({
  activate() {
    registerLauncherProvider({
      prefix: EVERYTHING_LAUNCHER_PREFIX,
      parse: (raw, filter) => ({ kind: "es", raw, filter }),
    });
  },
  deactivate() {
    unregisterLauncherProvider(EVERYTHING_LAUNCHER_PREFIX);
  },
});
