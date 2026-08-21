## Why

`plugin-host-sdk` 落地后首次全面走查发现：插件能力的主链路（清单 → 注册表 → 贡献点 → UI）已通，
但存在 4 个 P0 级缺陷——启用状态不持久化（重启全丢）、多窗口状态不同步、Everything 启动器无防抖且错误 toast 刷屏、
清单双源已经实际漂移（clickhouse 字段不一致）——以及一批 P1 级问题（旧面板连接去重失效、发现总线 prod 分支死代码、
不可用原因中文硬编码直出 UI 等）。这些缺陷会让用户在第一次真实使用插件开关时就丢配置，必须在插件能力对外宣传前修掉。

## 目标

- **启用状态持久化**：插件 enabled 状态写入 `omnipanel-store`，重启后完整恢复；禁用插件的贡献点（AI 工具、启动器前缀、侧栏入口、Tab）在重启后同样不出现。
- **多窗口一致**：任一窗口切换插件后，所有窗口（主窗 + module 子窗）的插件运行时状态在秒级内收敛，无需重启。
- **启动器体验**：`es` 前缀搜索加防抖；Everything 未运行时错误提示只出现一次，不随按键刷屏。
- **清单单一事实源**：`plugins/*/plugin.json` 成为唯一权威，Rust 侧不再手写副本；CI 校验双端（Rust / 前端 / check 脚本）消费的是同一份清单。
- **修复 P1 正确性问题**：旧版 `serviceType` 面板连接的二次导入去重、发现总线 prod 闸与任务取消联动、`unsupportedReason` i18n 化、Warpgate mock 标注诚实化。

## 非目标（Non-goals）

- **不做后端强制权限闸**：`conn_save` 等命令增加 plugin_id 参数并强制 `authorize_connection_write` 属于第三方插件开放前置条件，留待后续变更（当前全部第一方编译进包，前端 advisory 闸可接受）。
- **不收编 InvokeGateway**：everything search 从 `plugin_invoke` 特判分支迁入网关白名单是纯重构，不改变行为，本期不动。
- **不让启动器前缀接插件贡献点动态注册**：`es` 前缀仍静态登记，仅修体验。
- **不做插件市场、签名、热加载**（延续 plugin-host-sdk 非目标）。
- **不改七种 kind、权限枚举、清单 schema 本身**。

## 背景与动机

走查结论（2026-08，针对 plugin-host-sdk 实现；L2 workbench / L3 nacos 壳已落地，本期不重复做 Redis 插件或 Nacos 产品）：

| # | 级别 | 问题 | 位置 |
|---|------|------|------|
| 1 | P0 | `plugin_set_enabled` 只改内存 registry，无任何持久化；`seed_plugin_runtime` 每次启动重置为全启用 | `src-tauri/src/commands/plugin.rs` |
| 2 | P0 | 切换插件不 emit 事件，其他窗口 `pluginRuntimeStore` hydrate 一次后永久陈旧 | 同上 + `frontend/src/stores/pluginRuntimeStore.ts` |
| 3 | P0 | `es` 搜索每按键一次 IPC；未运行 Everything 时每键弹一个 toast | `frontend/src/components/shell/QuickLauncherRoot.tsx` |
| 4 | P0 | Rust `first_party.rs` 手写 10 份清单 vs `plugins/*/plugin.json`，clickhouse 的 `database.optional` 已漂移；check 脚本不查双端一致 | `crates/omnipanel-plugin/src/first_party.rs` |
| 5 | P1 | `findExisting` 面板去重对 legacy `serviceType:"1panel"` 失效（两条款都匹配不上插件 id），兜底去重会建重复连接 | `frontend/src/lib/pluginHost.ts` |
| 6 | P1 | `discovery_run` 后端 prod 分支是死代码（前端永远传 `envTag:null`）；任务中心「取消」管不到前端真正执行的 probe | `src-tauri/src/commands/plugin.rs` + `frontend/src/lib/discoveryBus.ts` |
| 7 | P1 | `unsupported_reason` 为 Rust 硬编码中文直出设置页，未走 i18n | `crates/omnipanel-plugin/src/registry.rs` |
| 8 | P1 | Warpgate 对话框 token 未使用却提示「已加载远程」；`importPanelPreviewRows` 把更新计成 added | `frontend/src/modules/importer/WarpgateImportDialog.tsx` |

影响 Phase：跨 Phase 的架构加固（对应 PRD §4.4 插件系统方向）；涉及路由 `/module/*`、设置页、快捷启动、任务中心；
不削弱 prod（`env_tag=prod`）确认策略——发现总线的 prod 主机仍一律跳过真实探测。

## What Changes

- **持久化**：`omnipanel-store` 新增 `plugin_settings(plugin_id PRIMARY KEY, enabled)` 表；`seed_plugin_runtime` 启动时读回覆盖默认值；`plugin_set_enabled` 写穿存储。
- **跨窗口同步**：`plugin_set_enabled` 成功后 emit `plugin://changed` 事件（payload 含 plugin_id 与新状态）；前端 `pluginRuntimeStore` 在每个窗口订阅该事件并 reload；贡献点消费方（引擎注册表、面板 Tab、模块壳、启动器）随 store 更新自动收敛。
- **启动器防抖与错误去重**：`es` 查询 250ms 防抖 + 竞态丢弃；`NotRunning` 类错误按会话只提示一次，后续静默置空结果区。
- **清单单源**：删除 `first_party.rs` 中手写的清单构造，改为构建期直接解析仓库 `plugins/*/plugin.json`（`include_str!` + serde 或 build.rs 生成）；`scripts/check-plugin-manifests.mjs` 增加「Rust 注册表 id/kind/permissions 与 JSON 一致」校验；修正 clickhouse 漂移字段。
- **去重修正**：`pluginHost.findExisting` 面板分支改用 `canonicalPanelPluginId` 归一化比较，legacy 别名（bt/baota/1panel/onepanel）与插件 id 等价。
- **发现总线语义落地**：删除后端永不触发的 prod 占位循环；`discovery_run` 仅负责任务中心登记与取消令牌；前端 probe 订阅同一取消令牌，取消时中止并标记任务取消；prod 主机维持前端过滤跳过并在结果中计数。
- **i18n**：`unsupported_reason` 改为稳定错误码（如 `platform.unsupported`），前端映射文案；设置页不再出现后端中文串。
- **Warpgate 诚实化**：mock 数据明确标注「示例数据」，token 输入在远程拉取实现前禁用或移除误导性成功提示；导入统计区分 added/updated。

## Capabilities

### New Capabilities

- `plugin-runtime`: 增补启用状态持久化、跨窗口事件同步、平台不支持原因的错误码合同。
- `plugin-manifests`: 第一方清单单一事实源与 CI 双端一致性门禁。
- `addon-everything`: 增补启动器 `es` 前缀的防抖、竞态与错误提示约束。
- `plugin-discovery`: 发现总线 prod 闸语义、任务取消联动与导入候选去重合同。

### Modified Capabilities

<!-- openspec/specs/ 目前为空；上述能力名与 plugin-host-sdk 变更中的 plugin-runtime / addon-everything 对应，为其增补修订。 -->

## 成功标准

- 启用→禁用 Everything 后重启应用：`plugin_list` 显示 disabled，AI 工具清单无 `omni_everything_search`，`es` 前缀无结果；再启用后全部恢复。
- 在设置窗口禁用 nacos 插件，已打开的 module 子窗侧栏入口与 `/module/nacos` 页面在 2 秒内消失，无需重启。
- `es ` 输入连续按键只发出防抖后的查询；未运行 Everything 时仅弹一次提示，继续输入不再弹。
- 修改任意 `plugins/*/plugin.json` 的 kind/permissions 使其与 Rust 注册表不一致时，`npm run check:plugin-manifests` 失败。
- 对已有 legacy `serviceType:"1panel"` 连接的主机重复执行 SSH 扫面板导入，结果为 updated/跳过而非新增重复连接。
- 任务中心取消发现任务后，前端 probe 不再产出候选行，任务状态为已取消。
- 设置页 Everything 行的平台不支持文案随语言切换（中/英），非 Windows 上 checkbox 保持禁用。
- 全程 `cd frontend && npx tsc -b` 零 error；`cargo test -p omnipanel-plugin -p omnipanel-store` 通过。

## Impact

- **后端**：`omnipanel-store`（新表 + 迁移）、`omnipanel-plugin`（first_party 单源化、unsupported_reason 错误码）、`src-tauri/src/commands/plugin.rs`（写穿存储、emit 事件、discovery_run 收敛）。
- **前端**：`stores/pluginRuntimeStore.ts`（事件订阅）、`components/shell/QuickLauncherRoot.tsx`（防抖/去重）、`lib/pluginHost.ts`（canonical 去重）、`lib/discoveryBus.ts`（取消联动）、`modules/importer/WarpgateImportDialog.tsx`、`components/settings/PluginsSettingsSection.tsx`（错误码映射）、i18n 中英文案。
- **CI**：`scripts/check-plugin-manifests.mjs` 增强；现有 `tsc -b` / cargo test 门禁不变。
- **数据**：新增 `plugin_settings` 表为纯增量迁移，不影响既有 connections/app_modules 数据；禁用插件不删除其已写入的连接（延续原合同）。
