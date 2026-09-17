/**
 * 位于 `plugins/<dir>` 但不随客户端 bundled 的插件目录。
 * 源码可 submodule 挂载；装载走市场 download（pack 进 plugins-latest）。
 * check / generate-registry / first_party 必须共同遵守本名单。
 */
export const DOWNLOAD_ONLY_PLUGIN_DIRS = new Set(["module-nacos"]);
