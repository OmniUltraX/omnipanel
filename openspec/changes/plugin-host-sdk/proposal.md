## Why

OmniPanel 的能力面正在按「加一种库、一家云、一个面板、一个怪工具」线性膨胀，但扩展方式仍是改封闭 enum 和巨型 `match`。再堆下去，Database / Server / 快捷启动会先被特判撑爆，而 Warpgate、Nacos、翻译、CDN 这类合理需求又进不了内核。现在需要一套 **Host + 七种插件身份 + 第一方 SDK**，让扩展走注册表，而不是改主程序。

## 目标

- 建立 **Plugin Runtime**：清单、权限、生命周期；第一方插件进仓库 `plugins/`，与宿主同一套 API。
- 锁定 **七种 kind**（不再随功能加第八种）：`engine` / `panel` / `importer` / `cloud` / `module` / `theme` / `addon`。
- 把现有机床收成 **Host**：领域工作台（库/面板/云/模块壳/文件/协议）+ 横切总线（连接台、发现、菜单/选区/Overlay、快捷启动、主题、OmniMCP、工作区）。
- 云从 Server 拆成 **独立侧栏** `/module/cloud`；阿里云作为第一方 `cloud` 插件。
- 连接模型打开引擎 id，新增 `kind=service` + 开放 `externalSource` 血缘，标签/分组/环境复用现有 Connection。
- 提供 `@omnipanel/plugin` 与 `@omnipanel/plugin-ui`，官方样板进仓库并进 CI（含 Windows 本机 Everything 搜索 addon）。

## 非目标（Non-goals）

- 本期 **不做插件市场、签名审核、任意第三方热加载 .dll/.so**。
- **不把终端 PTY、SSH 协议栈、Vault 实现、主 IPC `collect_commands!` 拆成插件**。
- **不让插件自建 WebView 窗口**；轻量交互走 Overlay 或快捷启动结果区。
- 不把每种中间件（Nacos/Kafka）做成新 kind；一律 `module`。
- 不在本期实现完整 Nacos 控制台、完整翻译产品、完整 CDN 控制台；只把插槽与样板路径打通。
- 不把 Everything SDK DLL 作为插件加载格式；本机搜索走 Everything IPC（命名管道 / WM_COPYDATA），不 `LoadLibrary` 官方 DLL 作为主路径。
- 不引入 Lua 作为主插件运行时（PRD §4.4 的 Lua/WASM 选型由本方案修正：声明式 + 第一方 TS/Rust 编译进包，HTTP 类后续可 WASM/sidecar）。

## 背景与动机

PRD §4.4 将插件系统放在 Phase 5 可选；§3.6 已写「插件化协议解析」。现状是半套准插件、没有宿主：

- `AppModule` 能开关，key 写死；侧栏 `navPaths` 写死。
- `DbDriver` / `DockerAdapter` 已有 trait，分发仍是 `match db_type` / `serviceType: "bt"|"1panel"`。
- `CloudProvider = "aliyun"`；云 UI 嵌在 Server。
- 快捷启动前缀闭集 `ssh|db`；全局右键靠 `withGlobalShareMenuItem` 硬注入「分享」。
- OmniMCP、工作区组件注册表、Navicat 导入预览、SSH 扫面板/Docker，都是可升格的贡献点。

业界对齐（学贡献点，不学重宿主）：

| 参考 | 采纳 | 不采纳 |
|------|------|--------|
| VS Code | 内置扩展走同一 API；commands/menus 公共插槽 | 一上来 Extension Host 进程网 |
| Grafana | 数据源 vs 工作台壳分离 | 每插件自带布局系统 |
| Raycast | 启动器是 Host，扩展只注册 provider | 每扩展一扇系统窗 |
| MCP / 现有 OmniMCP | AI 工具不再造第四套协议 | — |
| Obsidian | — | 同 WebView 跑不可信 JS |

影响 Phase：跨 Phase 1–5 的架构基线；路由 `/module/*`、新增 `/module/cloud`、设置外观/模块页；不削弱 prod 确认与 audit。

## What Changes

- **Plugin Runtime**：`PluginManifest`、七种 kind、权限闸、activate/deactivate；设置里启用/禁用。
- **贡献点注册表**：侧栏、连接表单、能力 Tab、导入预览、发现 probe、命令、菜单 `when`、Overlay、启动器前缀、主题包、OmniMCP tools、工作区组件。
- **连接模型**：`db_type` / 引擎 key 改为开放字符串；`ConnectionKind` **增加** `service`（模块插件实例）；`cloudSource` 升级为开放 `externalSource { pluginId, accountId, remoteId, remoteKind }`。
- **Cloud 独立模块**：从 Server 拆出侧栏入口；Tab 按厂商 `capabilities` 渲染；OSS「加入文件」、ECS/SWAS「加入 SSH」走血缘。
- **发现 + 导入闭环**：SSH/Docker/面板 probe → Candidate → 统一预览 → upsert；Warpgate、Navicat、扫 Nacos 共用。
- **Theme Host**：公开 CSS token 合同；暗/亮收成默认主题包；终端色板随包；插件 v1 禁止主题 JS。
- **Addon + 启动器**：菜单/命令/选区/Overlay 公共总线；快捷启动窗仍是内核，provider 可插。
- **仓库布局**：`packages/plugin-sdk`、`packages/plugin-ui`、`plugins/{db-*,panel-*,cloud-aliyun,importer-warpgate,theme-default,addon-everything}`；第一方 **编译进安装包**。
- **插件 Native AI 工具**：addon/engine 可向 OmniMCP 登记 `exec_kind=Native` 的工具（补齐静态 `BUILTIN_TOOL_SPECS` 无法表达插件工具的缺口）；清单支持 `platforms`（如仅 Windows）。
- **Everything 样板**：`plugins/addon-everything` 贡献 `omni_everything_search` + 可选启动器前缀 `es`；未运行 Everything 时失败并提示。
- **BREAKING（渐进）**：前端 `engine` 字面量联合类型打开为 `string`；`PanelConfigJson.serviceType` 迁移为插件 id（保留 bt/1panel 别名）；侧栏不再硬编码 `navPaths`。

## Capabilities

### New Capabilities

- `plugin-runtime`: 清单、七种 kind、权限、生命周期、第一方装载与模块开关。
- `plugin-hosts`: Host 分类（工作台 vs 总线）、贡献点合同、Host API 边界与禁止项。
- `plugin-connectors`: 引擎/面板/云/导入器；开放引擎 id；`service` 连接；`externalSource`；云独立侧栏。
- `plugin-surfaces`: 模块壳、addon（菜单/命令/Overlay/启动器 provider）、主题包与 token 合同。
- `plugin-sdk`: SDK/UI 包、官方样板、CI 狗粮。
- `addon-everything`: Windows Everything IPC 搜索 addon、Native MCP 工具、启动器前缀。

### Modified Capabilities

<!-- openspec/specs/ 目前为空，无既有能力被修改。 -->

## 成功标准

- 加一种 HTTP 类引擎（以现有 Qdrant 迁入 `plugins/db-qdrant` 验证）不再改 `ConnectionFormData.engine` 联合类型与 `Sidebar.tsx`。
- 1Panel / 宝塔 Tab 按 `capabilities` 出现，代码路径不再铺 `isOnePanel`/`isBt` 作为唯一分支。
- 云有独立侧栏；阿里云账户的 ECS 加入 SSH 后可按 `externalSource` 反查，再同步不重复造连接。
- Warpgate 样板能导入 SSH + MySQL/PG 草稿并写入 Vault；连接指向堡垒而非内网 IP。
- 快捷启动 `ssh`/`db` 来自 provider 注册表；新前缀只需插件登记；Everything 启用后 `es` 前缀可用。
- Windows 上启用 Everything addon 后，AI 可调 `omni_everything_search`；未启动 Everything 时工具失败且可理解；非 Windows 不激活该插件。
- 全局右键「分享」走菜单总线；主题切换同时更新 UI token 与终端色板，并经 `appearanceSync` 到子窗。
- 缺 `connections:write` / `ui:selection` / `ssh:exec` 时对应 Host API 失败，不静默降级。
- 生产环境（`env_tag=prod`）下导入、扫描、云开关机仍走既有确认策略。

## Impact

- **新目录**：`packages/plugin-sdk`、`packages/plugin-ui`、`plugins/*`、crate `omnipanel-plugin`（清单/权限/注册表）；Everything 查询 crate（如 `omnipanel-everything`，Windows IPC）。
- **后端**：`omnipanel-store`（AppModule 动态补种、ConnectionKind::Service、externalSource、插件 Native 工具登记）；`omnipanel-db` 引擎注册表；`omnipanel-docker` 面板能力；`cloud/aliyun.rs` 迁入第一方插件边界；IPC 经 specta。
- **前端**：`lib/paths.ts` / `appModuleStore` / `Sidebar` / `routePanels`；Database 连接对话框；Server 去掉云树；新 `modules/cloud`；`ContextMenu` 菜单总线；`quickLauncherMatch` provider 化；`tokens.css` 合同。
- **设置**：模块列表含插件模块（默认 closed）；外观含主题包。
- **安全**：凭据仍只走 Vault；插件不得直读 sqlite；扫描类需 `ssh:exec` 且可按主机授权。
