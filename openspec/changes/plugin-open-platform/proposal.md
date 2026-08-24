## Why

`plugin-host-sdk` 已落地静态声明式注册表（清单/权限枚举/启用持久化/贡献点 schema），但对 10 个官方插件的逐一审计表明：**插件目前只是 JSON 数据，没有任何可执行的插件代码；宿主按插件 ID 硬编码消费；权限闸是前端自觉而非后端强制**。这套形态作为内部重构是成功的，但无法开放给第三方：

- 清单经 `include_str!` / 前端源码 import 编译进二进制，无安装、卸载、签名、更新概念。
- `contributes.launcher / menus / overlays / discovery / importers` 在前端零消费（grep 无命中），各消费方手写插件 ID 数组。
- 设计中的 `activate(ctx)` 生命周期从未作为插件侧代码存在。
- `plugin_invoke` 网关除 Everything 特判外为空，权限校验只在 Everything 分支执行，无 audit。

要「后续开放这个能力」，必须先补两件事：**阶段 A——把第一方插件变成真插件**（泛化贡献点消费 + 真实 activate 生命周期 + 权限下沉），**阶段 B——定义包格式与安全边界**（磁盘包 + 签名 + 分级执行：声明式 → WASM → 沙箱 UI）。

## 官方插件现状审计（2026-08-21）

| 插件 | kind | 清单声明 | 真实支撑 | 缺口 |
|------|------|----------|----------|------|
| `omni.engine.redis` | engine | connectionForm(builtinLayout) + kv workbench | Rust 驱动 `redis.rs`(54KB)+`redis_ops.rs`(32KB)；engineRegistry 读 manifest 渲染表单/插槽 | 无（声明式消费的正面样板） |
| `omni.engine.qdrant` | engine | 表单+collections/points workbench | Rust 驱动 `qdrant.rs` | 同上 |
| `omni.engine.clickhouse` | engine | 全声明式 fields + SQL workbench | 新增 Rust 驱动 `clickhouse.rs`（408 行） | 同上，「加引擎不改联合类型」已验证 |
| `omni.panel.1panel` | panel | panelTabs×5 + discovery probe | `panelTabSlots` 取 manifest∩宿主插槽；mapProbe 做 candidate 映射 | PANEL_MANIFESTS 手写 import；Tab 组件是宿主的 |
| `omni.panel.bt` | panel | panelTabs×6 + probe | 同上 | 同上 |
| `omni.cloud.aliyun` | cloud | sidebar+panelTabs×5 | Rust OpenAPI 客户端 aliyun.rs(+537 行)、地域自动发现、externalSource 血缘 | **前端用硬编码常量 `ALIYUN_CLOUD_TABS`，不读 manifest** |
| `omni.importer.warpgate` | importer | importers[entry=commandPalette] | mapTargets.ts 映射逻辑+mock 夹具+单测；向导 UI 是宿主代码 | `contributes.importers` 无人读取，入口硬编码 |
| `omni.module.nacos` | module | sidebar+moduleKey | `/module/nacos` 路由 + PluginModuleHost 空壳页 | MODULE_PLUGIN_MANIFESTS 手写 import |
| `omni.theme.default` | theme | themes.tokens（近空） | `tokens.json` 被 terminalTheme.ts 直读（xterm ITheme） | manifest 与 tokens.json 双轨；无第三方主题装载路径 |
| `omni.addon.everything` | addon | launcher es + ai.tools×1 | omnipanel-everything crate（管道→WM_COPYDATA）；工具登记/网关/es provider 全部特判该 ID | 三处 ID 硬编码；非泛化 |

## 目标

- 阶段 A：宿主对贡献点的消费全部走 Registry 泛化路径，删除所有按插件 ID 的手写分支；第一方插件具备真实 `activate(host)` 入口并只经 Host API 干活；AI Native 工具按 manifest 泛化登记；权限校验下沉到后端强制 + audit 记 pluginId。
- 阶段 B：定义 `.omni-plugin` 包格式（zip：manifest + 资产 + 可选逻辑/UI 包）、ed25519 签名验证、从磁盘安装/卸载；三级执行梯度（L1 纯声明式先行开放 → L2 WASM 逻辑 → L3 沙箱 iframe UI）；Host API 后端强制化覆盖第三方路径。
- SDK 可交付：`@omnipanel/plugin-sdk` 发布 npm、脚手架模板、API 兼容策略文档。

## 非目标（Non-goals）

- 本期不做在线市场/商店 UI 与自动更新 CDN（安装以本地包 + 手动导入为入口）。
- 不做任意原生 `.dll/.so` 动态加载；不放开主 IPC `collect_commands!` 给第三方。
- 不在本期实现完整 Nacos 产品或翻译 addon；L3 沙箱 UI 本期只打通合同与样板，不做组件市场。
- Terminal PTY / SSH 协议栈 / Vault 实现/ specta 主命令表仍为内核，不插件化。

## What Changes

- **阶段 A（狗粮闭环）**
  - `plugin_list` 附带完整 manifest（或新增 `plugin_manifests`），前端 PluginCatalog 单源化；删除 `ENGINE_PLUGIN_MANIFESTS` / `MODULE_PLUGIN_MANIFESTS` / `PANEL_MANIFESTS` / `ALIYUN_CLOUD_TABS` 等手写数组。
  - 贡献点泛化消费：launcher 前缀、菜单项、overlay、importer 入口、discovery probe 全部从 activated manifests 读取。
  - 插件 `activate(ctx)` 合同落地：每个插件导出激活函数，统一 Runtime 加载器调用；第一方与未来第三方同一条代码路径。
  - AI 工具：`sync_native_plugin_tools` 改为遍历 manifests 的 `ai.tools`，executor 经 InvokeGateway 按 `(plugin_id, method)` 分发；消灭 Everything 特判。
  - 权限：`plugin_invoke` 网关对所有 method 先查清单 methods 白名单 + 权限，audit 日志记 pluginId/method 摘要。
- **阶段 B（开放边界）**
  - 包格式 `.omni-plugin`（zip）：`plugin.json` + `assets/` + 可选 `logic.wasm` + 可选 `ui/`；ed25519 签名文件校验。
  - 安装：`plugin_install_from_file` / `plugin_uninstall`，用户级目录存放；启用状态沿用现有 `plugin_settings`。
  - 执行梯度：L1 声明式（表单/主题 token/菜单/AI 工具元数据）零代码即可用，最先开放；L2 WASM（wasmtime，host functions = Host API 子集，缺权即 trap）；L3 沙箱 iframe + postMessage 桥渲染自定义 UI。
  - 第三方权限运行时：net/fs/ssh host functions 逐次检查 + prod 环境闸 + audit。
  - 生态件：npm 发布 SDK、`create-omnipanel-plugin` 脚手架、开发者文档。

## Capabilities

### New Capabilities

- `plugin-contributions`: 贡献点单源注册表与泛化消费（launcher/menu/overlay/importer/discovery/ai.tools/engine/module/panel/cloud/theme）。
- `plugin-loader`: `.omni-plugin` 包格式、签名验证、安装/卸载、用户级插件目录。
- `plugin-execution`: activate 生命周期、三级执行梯度（声明式/WASM/沙箱 UI）、Host API 强制权限与 audit。

### Modified Capabilities

<!-- openspec/specs/ 目前为空，无既有能力被修改。 -->

## 成功标准

- 删除任一官方插件的手写消费数组后，其功能仍随 enabled 状态出现/消失（单源验证）。
- Everything 的 AI 工具/es 前缀完全由 manifest + activate 驱动，`commands/plugin.rs` 中不再出现该插件 ID 字面量。
- 一个仅含 `plugin.json`（声明式表单 + 主题 token + AI 工具元数据）的未签名本地包可被安装并在重启后保持启用——这是 L1 开放的验收线。
- 含 `logic.wasm` 的包在缺权调用 host function 时收到明确错误且 audit 有记录；prod 主机扫描被拦截。
- 篡改包内任何字节后签名校验失败并拒绝安装。
- `npx create-omnipanel-plugin` 生成的模板能被 L1 流程直接装载。
