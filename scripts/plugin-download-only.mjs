/**

 * 位于 `plugins/<dir>` 但不随客户端 bundled 的插件目录。

 * 源码可 submodule 挂载；装载走市场 download（pack 进 plugins-latest）。

 * check / generate-registry / first_party 必须共同遵守本名单。

 */

export const DOWNLOAD_ONLY_PLUGIN_DIRS = new Set([
  "module-nacos",
  "cloud-aliyun",
  "cloud-tencent",
  "cloud-huawei",
  "cloud-aws",
  "cloud-azure",
  "cloud-digitalocean",
  "cloud-gcp",
  "cloud-bandwagon",
  "cloud-qiniu",
  "cloud-jdcloud",
  "addon-warpgate",
  // Agent sidecar：正式版按平台包下载；开发态由宿主懒编译后装进本地插件目录。
  "agent-cursor",
  "agent-workbuddy",
  "agent-trae",
  "agent-trae-global",
  "agent-opencode-go",
]);


