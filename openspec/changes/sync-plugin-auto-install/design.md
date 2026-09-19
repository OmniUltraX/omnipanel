## Context

模块快照（`client_sync_pull_modules` / `team_sync_pull_modules`）会把 `service` / `cloud` / `panel` 连接、数据库 `db_type`、知识源 `plugin:<id>:` 写到本机，但不会装插件。Nacos / `cloud-*` / 知识源是 `distribution: download`。现有 `ensureEngineForDbType` 只在打开库连接时懒装 DBX；`plugin_dbx_install_catalog_engines` 启动扫可选引擎，与同步资源无关。

commands 层已有完整安装入口，本变更在其上做缺件编排，不新开下载管线。

```
pull modules → apply_modules_bundle
        │
        ▼  前端 refreshLocalModuleUi
schedulePluginEnsure()
        │
        ▼  IPC plugin_ensure_from_resources
collect ids ← connections / db / ks_source_config
        │
        ├─ registry 已有（含 bundled / 已禁用）→ skip
        ├─ 官方 download → plugin_official_install
        ├─ DBX engine（非第一方）→ plugin_dbx_install
        ├─ 市场非官方源 → pendingConfirm（前端弹窗后再 approveIds）
        └─ 目录皆无 → notFound（不阻断、资源保留）
        │
        ▼
plugin://changed → 工作台入口出现
toast / 确认框 / 空态「去安装」
```

## Goals / Non-Goals

**Goals:**

- 同步落地后按本机资源反查 pluginId 并分级安装。
- 第一方官方与资源用到的 DBX 静默装；第三方确认后才装。
- 失败 / 未找到不回滚资源。
- 纯收集逻辑可单测；IPC 走 specta。

**Non-Goals:**

- 不把 `.omni-plugin` 打进 OSS。
- 不改启动「扫全部可选 DBX」；不在本期给「打开连接」挂通用 ensure（库引擎懒装已有）。
- 不自动启用用户已禁用的插件。
- Web 无插件运行时：命令失败则前端安静跳过。

## Decisions

1. **独立 IPC，不塞进 pull 返回**  
   pull 已慢（OSS + 解密）。ensure 由前端在 `refreshLocalModuleUi` 之后调用，确认框可挂在 App 根。备选：塞进 pull 结果——第三方确认仍要第二轮 IPC，收益小。

2. **收集在 commands，安装复用现有命令函数**  
   `Connection` / `DbConnectionConfig` / ks 表都在 store；分类依赖官方目录 / 市场 / DBX。放 `src-tauri/src/commands/plugin_ensure.rs`，直接调 `plugin_official_install` / `plugin_dbx_install` / `plugin_install_version`。不新增 crate 依赖。

3. **反查字段，不新增快照 `requiredPlugins[]`**  
   资源上已有 pluginId。显式列表要改 bundle 版本与双端。缺字段时以本机扫描为准，后续可加冗余字段。

4. **第三方确认用已有幽灵按钮对话框**  
   复用 `PluginDepConfirmDialog` 信息结构；新 `PluginEnsureHost` 挂在 `AppDialogHost` 旁。按钮用 `WorkbenchActionButton`。

5. **空态 CTA**  
   `PluginModuleHost` 在插件未激活时增加「去安装」→ `/plugins`。未找到的 id 记入 `pluginEnsureStore`（禁止 store import modules），插件中心读 store 展示横幅。

## Risks / Trade-offs

- [同步后连续下载多个包，拉长启动] → 仅装资源用到的；已装跳过；失败不阻断。
- [官方目录网络失败把第一方误判为第三方/未找到] → 官方优先，失败再试市场缓存；未找到只 toast。
- [静默安装带 net:connect 的第一方] → 仅官方签名源；第三方必须确认。
- [用户禁用的插件被重新启用] → registry 已有则 skip，包括 disabled。

## Migration Plan

无数据迁移。旧客户端忽略新命令则无自动安装。回滚：删 IPC 与前端调度即可。

## Open Questions

无。打开连接的通用 ensure 明确第二期。
