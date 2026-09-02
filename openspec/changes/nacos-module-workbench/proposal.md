## Why

`kind=module` 只有侧栏空壳，Nacos 若再写成编译进包的 React 特判，Kafka/Consul 还是要改主程序。现在要把 Nacos 打造成 **可安装的 module 模板**：Host 只认能力合同，插件以 `.omni-plugin`（清单 + L2 逻辑包）接入，后一只中间件只换包、不改内核。

## 目标

- 落地通用 **Module Host**：`/module/{key}` 提供 `kind=service` 实例树、声明式表单、标签、发现入口、按 `contributes.module.capabilities[]` 渲染的工作台（配置/服务/命名空间/节点等插槽）。
- **冻结 module 能力合同 + 包格式**：`plugin.json` + `logic.js`（L2，经 `host.netFetch` / `plugin_invoke`）；可用现有打包器打成 `.omni-plugin`，插件中心安装/卸载；`create-plugin.mjs module` 生成空模板。
- 用 **Nacos 做官方狗粮包**（可内置分发，但目录形状与第三方包相同）：1.x/2.x、配置发布/历史回滚、服务实例、集群节点、扫 8848、启动器与只读 AI。
- 凭据进 Vault；`env_tag=prod` 写操作走确认 + step-up + audit。禁用/卸载后面板与工具消失，连接数据保留。

## 非目标（Non-goals）

- **不**把主工作台做成 L3 iframe / 嵌官方 Console（CSP 拒外联；L3 只保留给未来「怪页面」Overlay，不是模板主路径）。
- **不**为 Nacos 新增 Rust crate 作为唯一实现（第三方装不了 `.dll`；方言与 OpenAPI 必须能放进 `logic.js`）。
- **不**让插件 React 进主 WebView（与 Vault/SSH 同进程红线）。
- **不**新增第 8 种 kind；不做在线商店；不做 Nacos 0.x / 3.x 必达、灰度编排、用户鉴权管理。
- **不**把 Terminal / SSH / Vault / specta 主命令表插件化。

## 背景与动机

开放梯度 L1/L2/L3 解决的是 **不可信代码怎么跑**；`kind=module` 解决的是 **有没有独立工作台**。两者正交。

- L1 已能装声明式引擎/主题；L2 已有 Warpgate `logic.js` + `host.netFetch`；安装/验签已通。
- 缺的是：**module 能力合同**（像云的 `contributes.cloud.capabilities`）和 **module 脚手架**。没有这两样，Nacos 只能继续编译进包。
- 云模块证明 Host 画格子、插件填能力可行。Module 应对齐：Host 画配置列表/编辑器/服务表，插件只实现 methods。

影响 Phase：`/module/nacos`（默认 closed）；插件中心安装路径；横切连接台 / 发现 / OmniMCP。

## What Changes

- **能力合同**：`contributes.module.capabilities[]` 冻结 id：`namespace` / `config` / `discovery` / `cluster`（后续 Kafka 用新 id，未声明则无树节点）。
- **Module Host**：按激活插件的能力渲染树与 Dock；连接对话框读 `connectionForm`；无自定义 UI 代码。
- **可安装包**：Nacos 与模板均为 `plugin.json` + `entry.logic=logic.js` + 可选 icon；`pack` → 插件中心安装；内置 id 不可卸、磁盘安装可卸。
- **脚手架**：`node scripts/create-plugin.mjs <name> module` 生成 `plugins-custom/` 空模块包（清单 + 桩 methods + README）。
- **Nacos 狗粮**：`logic.js` 实现探测、1.x/2.x 方言、配置/命名/服务/节点；扫描 mapper 可放 L2 或声明 + 宿主通用端口探测。
- **AI / 启动器**：仍由清单声明，执行进 L2 methods。
- **BREAKING**：无。默认 closed。

## Capabilities

### New Capabilities

- `module-host`: 通用壳、service 连接、能力驱动工作台、标签与门控。
- `module-template`: `.omni-plugin` 包形状、安装卸载、`create-plugin` module 脚手架。
- `nacos-console`: Nacos L2 狗粮（1.x/2.x、发布/回滚、服务、节点、凭据与危险写）。
- `nacos-discovery`: SSH/Docker 扫描与导入去重。
- `nacos-ai`: 启动器前缀与只读 OmniMCP 工具。

### Modified Capabilities

- （`openspec/specs/` 目前为空。）

## 成功标准

- `pack plugins/module-nacos` 得到的包能在干净配置里安装、启用、出现 `/module/nacos`；卸载后面板与工具消失，连接仍在。
- `create-plugin.mjs foo module` 打出的空包能安装；声明了 `config` 就出现配置插槽，调用桩 method；不改 Host 源码。
- Nacos 狗粮：1.x/2.x 测通、发布/回滚、prod 确认、扫描去重、`nacos` 前缀与只读 AI，与原产品成功标准相同。
- 再做 Consul/Kafka：新包 + 能力声明 + `logic.js`，Host 树/对话框/编辑器 **零分支**。
- 仓库内 **无** `if (moduleKey === "nacos")` 画工作台；**无** 必依赖的 `omnipanel-nacos` crate。

## Impact

- **前端 Host**：`modules/plugin-module` 能力工作台；`pluginManifests` 解析 `contributes.module`；i18n。
- **插件包**：`plugins/module-nacos`（清单 + `logic.js`）；`plugins-samples/module-starter`；`scripts/create-plugin.mjs` 增加 `module`。
- **运行时**：已有 L2 QuickJS + `plugin_invoke` + Vault + 安装器；Nacos methods 走 L2，不新增 specta 业务命令。
- **SDK**：`packages/plugin-sdk` 增补 `contributes.module.capabilities` schema；CI `check:plugin-manifests`。
- **安全**：L2 `net:connect` / `vault:read` / `ssh:exec` 仍由宿主闸；插件 JS 不进主 WebView。
