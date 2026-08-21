## Context

`plugin-host-sdk` 变更已落地插件主链路：crate `omnipanel-plugin`（清单/权限/注册表/网关）、
`src-tauri/src/commands/plugin.rs`（plugin_list / plugin_set_enabled / plugin_invoke / plugin_require_permission /
discovery_run）、前端 `pluginRuntimeStore` + 各贡献点消费方。走查确认四个 P0 缺陷与一批 P1 问题
（见 proposal 背景表）。本设计只修缺陷与合同，不改变七种 kind、权限枚举、清单 schema 与既有 IPC 命令签名
（bindings 由 tauri-specta 重新生成，命令集合不变，仅 discovery_run 内部行为收敛）。

关键现状约束：

- `AppState.plugin_registry: Arc<Mutex<PluginRegistry>>` 为进程级单例；多窗口共享同一后端 registry，
  分叉只发生在各窗口前端的 `pluginRuntimeStore`。
- `omnipanel-store::Storage` 已有 `repair_app_modules*` 系列先例，新表迁移沿用其 `conn()` + `map_sqlite` 模式。
- 前端已有全局事件订阅先例（terminal-event 等），`@tauri-apps/api/event` 的 `listen` 可直接复用。
- 任务中心 `worker_pool.spawn(app, module, kind, title, total, closure)` 提供 cancel 原子量与 progress 回调。

## Goals / Non-Goals

**Goals:**

- 插件 enabled 状态持久化 + 启动恢复。
- 单一 `plugin://changed` 事件驱动全窗口收敛。
- `es` 启动器防抖、竞态丢弃、NotRunning 错误会话内去重。
- 清单单源：Rust 构建期读 `plugins/*/plugin.json`；CI 双端一致性校验。
- 面板候选去重 canonical 化；发现总线 prod 语义与取消联动落地；unsupported_reason 错误码化；Warpgate mock 诚实标注。

**Non-Goals:**

- 后端强制权限闸（conn_save 带 plugin_id）、InvokeGateway 收编 everything 特判、启动器前缀动态接贡献点——留待后续变更。
- 不做插件市场/签名/热加载；不改清单 schema 本身。

## Decisions

### D1. 持久化：独立 `plugin_settings` 表，而非塞进 settings KV

```sql
CREATE TABLE IF NOT EXISTS plugin_settings (
  plugin_id TEXT PRIMARY KEY,
  enabled   INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
```

- 放 `omnipanel-store` 新文件 `plugin_settings.rs`：`plugin_enabled_list() -> Vec<(String, bool)>`、
  `plugin_enabled_set(plugin_id, enabled)`。理由：插件是稳定实体集合（编译期确定），行式表比 KV JSON 更可查询、
  可加列（未来 per-permission 授权）；且 store 层单测可直接覆盖。
- 备选「settings 表存 JSON」被否：无法表达 per-plugin 行级更新，且现有 settings KV 是整包读写，粒度太粗。
- **写穿顺序**：`plugin_set_enabled` 先写存储成功 → 再改内存 registry → 再同步工具/发事件；存储失败则整体返回
  `OmniError` 且内存不动，避免分叉。启动时 `seed_plugin_runtime(storage)` 读回一次覆盖默认值。

### D2. 跨窗口同步：单一 Tauri event `plugin://changed`，各窗口 reload

```
设置窗口 toggle ──► plugin_set_enabled ──► storage 写穿
                                          ├─► registry.set_enabled + sync_native_plugin_tools
                                          └─► app_handle.emit("plugin://changed", {pluginId, enabled, activated})
                                                      │
        ┌─────────────────────────────────────────────┘
        ▼ (每个窗口 Bootstrap/ModuleWindowRoot 已有 listen 先例)
pluginRuntimeStore.subscribeChanged(): reload() ──► items 更新
        ├─ engineRegistry / panelTabSlots / panelPlugin（读 store 的函数自动收敛）
        ├─ Sidebar / PluginModuleHost（getNavVisibleModuleKeys 重算）
        └─ QuickLauncherRoot（everythingEnabled selector）
```

- 事件 payload 仅作通知（pluginId/enabled/activated 摘要），最终状态以各窗口重新 `plugin_list` 为准——
  避免 payload 与 DB 在并发切换下不一致。
- 订阅点放 `pluginRuntimeStore.ts` 内部模块级 `initPluginRuntimeStore()` 中一次性 `listen`（去重防重复注册），
  主窗与 module 子窗的既有初始化路径都经过它，无需改调用方。
- 备选「broadcast channel + 自定义 IPC」被否：Tauri 2 emit/listen 已是项目惯例，零新依赖。

### D3. 启动器防抖与错误去重：组件层实现，不进 lib

- `QuickLauncherRoot` 的 es effect 外提为 `useDebouncedEsQuery(filter, enabled)`（250ms）；
  用递增 seq ref 做竞态丢弃（响应到达时 seq 不匹配即弃）。
- 错误去重：模块级 `let notRunningNotified = false` 会话标记；`EverythingError` 归类为
  NotRunning/UnsupportedPlatform 时首次 toast、之后 `setEsRows([])` 静默；收到成功响应时重置标记。
  判定依据：错误消息匹配交给后端结构化——`OmniError.kind` 已区分 connection 类，前端按
  `err.kind === "connection"`（或 code）判定，不做中文字符串匹配。
- 备选「把防抖下沉到 quickLauncherMatch.ts」被否：该文件是纯函数匹配库且有 vitest 合同，保持纯净。

### D4. 清单单源：构建期 include_str! 解析 JSON，删除手写副本

- `first_party.rs` 改为：

```rust
macro_rules! first_party_manifest {
    ($dir:literal) => {
        PluginManifest::from_json(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../plugins/", $dir, "/plugin.json")))
            .expect("第一方清单必须合法")
    };
}
```

  `first_party_manifests()` 返回按目录名解析的结果；`PLUGIN_ID_*` 常量保留（代码引用需要），但增加
  「常量 == JSON.id」的启动断言/单测。
- crate 需在 `Cargo.toml` 声明 `include` 覆盖仓库 `plugins/`（或用相对路径 include_str! 即可触发 rebuild 依赖，
  cargo 对 include_str! 文件有重建追踪，无需 build.rs）。
- `check-plugin-manifests.mjs` 增强：解析 `crates/omnipanel-plugin/src/first_party.rs` 中的目录清单
  （宏调用列表），逐一比对 JSON 的 id/kind/permissions/platforms；枚举表改为从
  `packages/plugin-sdk/src/index.ts` 正则提取 zod enum，消除第三处手写。
- clickhouse 漂移字段以 plugin.json 为准（补 Rust 侧消失即自然修复）。
- 备选「build.rs 生成 Rust 代码」被否：引入生成文件流程复杂度，include_str! + expect 已满足编译期校验。

### D5. 面板候选去重：统一走 canonicalPanelPluginId

`pluginHost.findExisting` 面板分支改为：

```ts
canonicalPanelPluginId(cfg.serviceType) === canonicalPanelPluginId(candidate.pluginId)
```

与预览层 `panelDiscovery.existingPanel` 同一规则；抽 `panelCandidateMatches(conn, candidate)` 共享函数放
`panelPlugin.ts`，两处调用，杜绝再次分叉。docker/ssh 分支维持现规则不动。

### D6. 发现总线：删 prod 死分支，取消令牌下探到前端 probe

- 后端 `discovery_run` 收敛为：参数校验 → `worker_pool.spawn` 登记任务 → 循环 hostIds 仅做
  progress 上报 + cancel 检查（不再模拟 prod 等待循环）；返回 task_id。
- 取消联动：任务中心已有取消入口写 cancel 原子量。新增最小事件桥——spawn 闭包内检测到 cancel 置位时
  `app.emit("plugin://discovery-cancelled", { taskId })`；前端 `runDiscoveryProbe` 持有 taskId，
  注册一次性 listener，收到即中止后续 probe 并返回 `{ skipped: true, reason: "cancelled" }`。
  同时保留轮询兜底（probe 批次间检查任务状态接口，若事件丢失最多多做一批）。
- prod 过滤维持在前端 `sshDiscoveryScope`（唯一事实点），结果对象带 `skippedProdCount`；
  后端不再接收 envTag 参数语义（字段保留以兼容 bindings，但文档注明由前端过滤）。
- 备选「probe 全部下沉后端执行」被否：probe 依赖前端连接 store 与映射器，下沉是 plugin-host-sdk 后续演进，不在本期。

### D7. unsupported_reason 错误码化

- `PluginEntry.unsupported_reason: Option<String>` 改存稳定码（本期仅 `platform.unsupported`）；
  `PluginListItem` 字段类型不变（仍 Option<String>），bindings 无破坏性变更。
- 设置页 `PluginsSettingsSection` 建 `UNSUPPORTED_REASON_KEYS: Record<string, string>` 映射 i18n key，
  未识别码回退显示原文。i18n 增加 `plugins.unsupported.platform`（zh/en）。

### D8. Warpgate 诚实化

- 向导加载按钮文案/状态固定为「加载示例数据」；token 输入框保留但旁注「远程拉取即将支持」，
  `loadCandidates` 不再根据 token 切换 loadedRemote 提示。
- `importPanelPreviewRows` 统计：upsert 前先查 existing（复用 D5 共享函数），命中计 updated，否则 added。

## Risks / Trade-offs

- [D1 存储写穿增加 toggle 延迟] → SQLite 单行 upsert <1ms，且 toggle 本身低频；失败路径返回明确错误优于静默分叉。
- [D2 事件风暴] → toggle 为人工低频操作；store reload 幂等且带 hydrated 守卫，重复触发无害。
- [D4 include_str! 使 omnipanel-plugin 依赖仓库目录结构] → 第一方插件本就随仓库分发（plugin-host-sdk 决策）；
  CI 一致性校验兜底路径错位会在编译期/CI 期暴露而非运行期。
- [D6 事件丢失导致取消不生效] → 批次间轮询任务状态兜底，最坏多执行一批 probe；prod 主机始终在前端过滤，无安全风险。
- [D7 错误码方案约束未来新增原因] → 新原因必须同时加码与 i18n，未识别码回退原文保证不白屏。
- [整体] → 所有改动不新增重型依赖（无新 npm 包、无新 crate），符合 PRD 技术栈边界。

## Migration Plan

1. store 迁移（CREATE TABLE IF NOT EXISTS，纯增量）→ 2. 后端 seed/set_enabled 写穿 + emit →
3. 前端订阅 + 防抖/去重 + 去重归一化 → 4. 清单单源化 + CI 增强 → 5. discovery 收敛 + Warpgate/i18n 收尾。
每步独立可编译、可回归（tsc -b + cargo test）。回滚：任一步独立 revert 均不影响其他步；
`plugin_settings` 表残留无害（无消费者时被忽略）。

## Open Questions

- `plugin://discovery-cancelled` 是否并入未来统一的任务中心事件体系（global-task-center 变更）？
  本期先用独立频道，命名预留 `plugin://` 前缀空间。
- 未来 per-permission 授权是否扩展 `plugin_settings` 加列——本期只建 `enabled` 列，不加权限列。
