/** 宿主插件运行时类型入口。插件 UI 请用 `@omnipanel/plugin-ui`，禁止 import `modules/*`。 */
export type { PluginHost, PluginManifest, PluginKind, ExternalSource } from "@omnipanel/plugin-sdk";
export { parsePluginManifest, pluginManifestSchema } from "@omnipanel/plugin-sdk";
export { Button as PluginButton, Dialog as PluginDialog } from "@omnipanel/plugin-ui";
