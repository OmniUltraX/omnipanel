## Why

云模块已经从 Server 拆到 `/module/cloud`，但能力仍按阿里云产品名写死：`CloudProvider = "aliyun"`、地域当树节点、右侧内嵌 ecs/swas/oss Tab、OpenAPI 与 IPC 全在宿主。再接腾讯云/AWS 等于再写一套。现在要把 **Cloud Host 收成数据库那样的工作台**，厂商只实现同一套能力合同。

## 目标

- 冻结云厂商 **能力合同**（开放字符串）：`compute` / `compute.lite` 分开，另含 `objectStorage` / `domains` / `dns` / `certs` / `cdn`；行、详情文档、动作、三个稳定 Driver 入口。
- Cloud Host 信息架构对齐数据库：树为 **账户 → 能力 → 实例**；地域是筛选标签不是树节点；右侧 Dock 为 **概览 / 资源列表 / 资源详情**；单击预览、双击常驻。
- 阿里云作为第一个 `kind=cloud` Driver：签名与映射进插件 crate，经 `plugin_invoke` 分发；宿主不再 `switch(ecs)` / `cloud_list_ecs`。
- 列表与详情覆盖尽量全面的工作台动作（开停重启、加入 SSH/文件、控制台、详情字段），`env_tag=prod` 写操作走既有确认 + audit。
- 禁用 `omni.cloud.aliyun` 后芯片、树能力、列表消失；账户连接数据保留。

## 非目标（Non-goals）

- 本期 **不实现** 第二家厂商（腾讯云 / 华为云 / AWS）；合同必须让第二家只加插件 crate + 清单。
- **不**把 Cloud Host 壳、Vault、SSH/文件加入、specta 主命令表插件化。
- **不**做完整云控制台（账单、RAM/IAM 用户管理、VPC 编排、对象浏览器替代 Files）。
- **不**用 L3 iframe 做详情；第一方详情走 Host 插槽 + 规范化文档。
- **不**把 DNS 解析记录挂上树（托管区才是实例）；**不**动态加载原生 `.dll/.so`。
- 不做 CDN 完整控制台；阿里云未声明 `cdn` 则不出节点，合同预留能力 id。

## 背景与动机

`plugin-host-sdk` 已把云做成独立模块与 `omni.cloud.aliyun` 清单，但消费仍是阿里云专有：

- 树：账户 → 地域；产品类型藏在右侧内 Tab。
- IPC：`cloud_list_ecs` 等按产品拆命令；后端 `aliyun.rs` 双份（crate + src-tauri）。
- 插件无 `activate`、不看 `isPluginActivated`；`CloudResourceTab` 封闭联合。
- 行上几乎只有「加入 SSH/文件」，无账户概览、无实例详情、无开停机。

数据库已验证「连接 → 库 → 表」+ 概览/列表/详情 + 单击预览双击常驻。云对象同样是账户下的资源类与实例，应对齐这套 IA，而不是把筛选条件（地域）当成树。

影响 Phase：云模块 `/module/cloud`（Phase 3 服务器/云）；不改 Terminal/SSH 协议栈。跨模块仅 SSH、文件（`externalSource` 已有）。

## What Changes

- **能力合同**：清单 `contributes.cloud.capabilities[]`（id、scope、columns、actions、详情 schema）；`connectionForm` 替代写死 AK 表单；`methods[]` 白名单 `testAccount` / `listRegions` / `listResources` / `getResource` / `invokeAction`。
- **Driver 注册表**：`CloudProviderDriver` trait；第一方 crate 编译期登记 `InvokeGateway`；宿主 3～5 条泛化 specta 命令，按连接 `pluginId` 分发。
- **Cloud Workbench Host**：三层树懒加载实例；地域/状态筛选同时作用于树与列表；Dock Tab `account` | `resources` | `resource`。
- **阿里云迁入**：ECS→`compute`、SWAS→`compute.lite`、OSS→`objectStorage`、域名→`domains`、证书→`certs`；删除产品级 IPC 与 `CloudProvider = "aliyun"` 联合。
- **动作**：宿主执行 `addSsh` / `addToFiles`；插件执行 `start` / `stop` / `reboot` 等；控制台为外链。prod 确认不可绕过。
- **BREAKING（渐进）**：连接 `config.provider` 改为开放字符串（可与 `pluginId` 并存）；旧 `aliyun` 别名映射保留；前端不再认 `ecs|swas` 为树/Tab 类型。

## Capabilities

### New Capabilities

- `cloud-capability-contract`: 能力 id、行/详情文档、动作分档、Driver method、凭据与权限。
- `cloud-workbench-host`: `/module/cloud` 树与 Dock、筛选、预览/常驻、启用门控、账户对话框芯片。
- `cloud-aliyun-driver`: 阿里云第一方实现与旧 API/UI 迁移。

### Modified Capabilities

- （`openspec/specs/` 目前为空；`plugin-host-sdk` 中「云独立侧栏 / 按 capability 渲染 Tab」由本变更的 Host spec 收紧为三层树 + 三级 Dock，不在此列 delta。）

## 成功标准

- 禁用阿里云插件后：加账户对话框无该芯片、已有账户不展示能力子树与列表；连接记录仍在。
- 树为账户 → 能力 → 实例；地域只出现在筛选与节点标签，不作为树层级。
- 点账户打开概览，点能力打开列表，点实例打开详情；单击预览、双击常驻；可同时开 ECS 列表与 OSS 列表。
- 前端与 specta **无** `cloud_list_ecs` / `CloudResourceTab = ecs|swas|…` 主路径；列表走 `listResources(capability, …)`。
- 阿里云 ECS 开/停/重启在 prod 账户上弹出既有生产确认；成功写 audit；缺声明的 action 不显示按钮。
- ECS 加入 SSH、OSS 加入文件仍按 `externalSource` 去重反查。
- 第二家厂商（未实现）在设计上只需新清单 + Driver 登记，不改 Host 树/Dock/泛化 IPC。

## Impact

- **后端**：新 crate（如 `omnipanel-cloud-aliyun`）承接 OpenAPI；`omnipanel-server` / `src-tauri/commands/cloud` 改为泛化分发；`plugin_invoke` 登记 method；两份 `aliyun.rs` 合并。
- **前端**：`modules/cloud` 工作台；`modules/server/cloud` 逐步收进云模块或仅留跨模块链接；`pluginManifests` / `cloudCapabilities`；i18n；账户对话框对齐引擎芯片。
- **插件**：`plugins/cloud-aliyun/plugin.json` 改为能力合同；可选 `definePlugin`。
- **IPC**：`npm run gen:bindings`；旧 `cloud_list_*` 删除或仅内部兼容一层后移除。
- **安全**：AK 仍 Vault；写操作 + `env_tag=prod` → ExecutionEngine / `appConfirm`；audit 记 `pluginId` + action。
