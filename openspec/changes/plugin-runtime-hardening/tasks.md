## 1. 存储层（crates/omnipanel-store/）

- [x] 1.1 新增 `plugin_settings.rs`：`plugin_settings` 表迁移（CREATE TABLE IF NOT EXISTS，plugin_id 主键 + enabled + updated_at）、`plugin_enabled_list()`、`plugin_enabled_set()`；挂入 `lib.rs`。验证：`cargo test -p omnipanel-store` 新增单测（默认空、set 后 list 回读、重复 set 覆盖）
- [x] 1.2 迁移回归：确认旧库打开时自动建表且不影响既有 connections/app_modules 数据。验证：store 单测用内存库模拟旧 schema 升级

## 2. 插件 crate（crates/omnipanel-plugin/）

- [x] 2.1 清单单源化：`first_party.rs` 改为宏 + `include_str!("plugins/*/plugin.json")` 解析，删除手写清单构造；保留 `PLUGIN_ID_*` 常量并加「常量 == JSON.id」断言单测；以 plugin.json 为准修正 clickhouse 漂移字段。验证：`cargo test -p omnipanel-plugin`
- [x] 2.2 `unsupported_reason` 错误码化：registry 中平台不匹配原因改存稳定码 `platform.unsupported`（`PluginListItem` 字段类型不变）。验证：`cargo test -p omnipanel-plugin` 更新 `non_windows_skips_activate` 断言

## 3. Tauri 命令层（src-tauri/src/commands/plugin.rs、state.rs）

- [x] 3.1 启动读回：`seed_plugin_runtime` 接收 storage，读 `plugin_enabled_list()` 覆盖默认 enabled 后再 `activate_enabled`（`state.rs` 调整调用）。验证：`cargo test -p omnipanel-plugin` + 手动启动确认
- [x] 3.2 写穿与事件：`plugin_set_enabled` 改为「存储写穿成功 → registry.set_enabled → sync_native_plugin_tools → emit `plugin://changed`（payload 含 pluginId/enabled/activated）」；存储失败返回 OmniError 且内存不动。验证：命令签名不变（**不跑** `gen:bindings`）；事件名走 `frontend/src/ipc/events.ts`；手动 toggle 观察事件
- [x] 3.3 discovery_run 收敛：删除 prod 占位等待循环，仅保留任务登记、progress 上报与 cancel 检查；cancel 置位时 emit `plugin://discovery-cancelled`（含 taskId）。验证：`cargo build` + 手动取消任务观察事件

## 4. 前端运行时（frontend/src/stores/、frontend/src/lib/）

- [x] 4.1 `pluginRuntimeStore.ts`：`initPluginRuntimeStore` 内一次性订阅 `PLUGIN_CHANGED`（`ipc/events.ts`，模块级去重），触发 `reload()`；导出供既有 Bootstrap/ModuleWindowRoot/QuickLauncherRoot 初始化路径复用。验证：vitest 新增 store 订阅测试（mock listen）
- [x] 4.2 `pluginHost.ts` 面板去重归一化：面板分支改用共享判定函数（与 `panelDiscovery.existingPanel` 同规则，放 `panelPlugin.ts` 的 `panelCandidateMatches`）；legacy 别名 bt/baota/1panel/onepanel 与插件 id 等价。验证：vitest 覆盖 legacy serviceType 命中更新而非新建
- [x] 4.3 `discoveryBus.ts` 取消联动：`runDiscoveryProbe` 持有 taskId 订阅 `plugin://discovery-cancelled`（一次性 listener）+ 批次间轮询兜底，取消后返回 `{ skipped: true, reason: "cancelled" }` 并停止产出候选。验证：vitest mock 事件触发中止
- [x] 4.4 i18n：zh-CN/en-US 增加 `plugins.unsupported.platform` 文案。验证：`cd frontend && npx tsc -b`

## 5. 设置页与导入向导（frontend/src/components/settings/、frontend/src/modules/importer/）

- [x] 5.1 `PluginsSettingsSection.tsx`：`unsupportedReason` 经错误码映射表转 i18n 文案，未识别码回退原文；checkbox 禁用逻辑不变。验证：手动切中英语言核对文案
- [x] 5.2 Warpgate 向导诚实化：加载按钮/状态固定标注示例数据，token 不再触发 loadedRemote 提示（旁注「远程拉取即将支持」）；`syncPanelsFromSsh.importPanelPreviewRows` 统计区分 added/updated（复用 4.2 共享判定）。验证：手动走一遍向导 + vitest 统计断言

## 6. 快捷启动器（frontend/src/components/shell/QuickLauncherRoot.tsx）

- [x] 6.1 es 查询防抖与竞态丢弃：250ms 防抖 + seq ref 竞态保护，插件未启用不发请求。验证：vitest 防抖行为或手动连续输入观察网络面板
- [x] 6.2 NotRunning 错误会话内去重：按后端结构化错误（kind/code）判定，首次 toast、后续静默置空，成功响应重置标记。验证：停止 Everything 手动连输多次只提示一次

## 7. CI 门禁（scripts/check-plugin-manifests.mjs）

- [x] 7.1 一致性校验：解析 `first_party.rs` 宏目录清单，逐一比对 plugin.json 的 id/kind/permissions/platforms；枚举表改为从 `packages/plugin-sdk/src/index.ts` 提取 zod enum。验证：本地构造不一致样例跑 `npm run check:plugin-manifests` 必须失败，还原后通过

## 8. 联调与验收

- [x] 8.1 全量门禁：`cd frontend && npx tsc -b` 零 error；`cargo test -p omnipanel-plugin -p omnipanel-store` 通过；`npx vitest run` 相关新增用例通过
- [ ] 8.2 手动验收清单：禁用 Everything → 重启保持禁用且 AI 工具/es 前缀消失 → 再启用恢复；设置窗禁用 nacos → 子窗侧栏入口 2 秒内消失；legacy 1Panel 连接重复导入不新建；发现任务中途取消前端 probe 停止；prod 标签主机始终跳过探测并计数（不发起任何针对 prod 的请求）
