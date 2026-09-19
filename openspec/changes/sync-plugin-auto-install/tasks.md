## 1. 收集缺件 id

- [x] 1.1 实现连接 / db_type / 知识源 `source_key` 的 pluginId 反查纯函数（`src-tauri/src/commands/plugin_ensure.rs`）。验证：单元测试覆盖 service/cloud/panel 别名、mysql 跳过、dm→dameng、`plugin:<id>:`
- [x] 1.2 `Storage` 增加列出 `ks_source_config.source_key`（`crates/omnipanel-store/src/ks_sync.rs`）。验证：`cargo test -p omnipanel-store` 相关通过

## 2. ensure 命令

- [x] 2.1 官方目录 / 市场合并源查找辅助（`src-tauri/src/commands/official_catalog.rs`、`marketplace.rs`）。验证：已有目录测试不回归
- [x] 2.2 实现 `plugin_ensure_from_resources`：skip / 官方静默 / DBX 静默 / 第三方 pending / notFound / failed（`plugin_ensure.rs`）。验证：`cargo test -p omnipanel --lib plugin_ensure`
- [x] 2.3 双清单注册命令并 `npm run gen:bindings`（`src-tauri/src/lib.rs`、`commands/mod.rs`）。验证：`npm run check:ipc-registry`

## 3. 前端调度与确认

- [x] 3.1 `pluginEnsureStore` + `lib/pluginEnsure.ts` 调用 IPC、toast、写 pending（`frontend/src/stores/`、`frontend/src/lib/`）。验证：store 不 import modules
- [x] 3.2 模块快照刷新后调度 ensure（`frontend/src/modules/clientSync/pullCloudSnapshot.ts`、`switchSyncTeam.ts`）。验证：vitest 或手动 pull 路径仍刷新 UI
- [x] 3.3 `PluginEnsureHost` 挂 App 根，第三方确认后带 `approveIds` 再调（`frontend/src/modules/plugins/`、`App.tsx`）。验证：幽灵按钮；取消不安装

## 4. 空态与文案

- [x] 4.1 `PluginModuleHost` 未激活时「去安装」进插件中心（`frontend/src/modules/plugin-module/PluginModuleHost.tsx`）。验证：WorkbenchActionButton；无实心蓝
- [x] 4.2 中英 i18n（`frontend/src/i18n/locales/zh-CN/plugins.ts`、`en-US/plugins.ts`）。验证：无硬编码用户串

## 5. 门禁

- [x] 5.1 收集函数与前端 store/ensure 单测。验证：vitest 相关通过
- [x] 5.2 `cd frontend && npx tsc -b` 零 error
