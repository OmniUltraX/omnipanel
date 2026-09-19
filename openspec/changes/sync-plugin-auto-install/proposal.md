## Why

模块快照同步会把 Nacos / 云厂商 / DBX 引擎 / 知识源等**依赖插件的资源**写到本机，但不会安装对应插件。接收端连接在、入口没了：`isPluginActivated()` 为 false，侧栏和工作台直接过滤掉。插件已是 download-only 交付，同步缺件收口必须现在补上。

## 目标

- 模块快照落地后，按本机资源反查所需 `pluginId`，对未安装且目录可解析的包执行 ensure 安装。
- 官方第一方（`plugin_official_install`）与资源真正用到的 DBX 引擎静默安装；第三方市场包装一次权限确认。
- 目录找不到的包不阻断同步：资源保留，模块空态给出「安装插件」。
- 复用现有安装 / 验签 / 原子 swap / 依赖解析，不新开下载管线。

影响模块：客户端同步（`client_sync_*` / `team_sync_*`）、插件中心、数据库 / 云 / 模块 / 面板 / 知识库工作台。生产库操作本身仍走 `env_tag=prod` 二次确认；本变更只装插件，不执行资源上的写操作。

## 非目标（Non-goals）

- 不把插件包打进 OSS 快照（仍从官方/市场/DBX 目录拉）。
- 不改启动时「扫一遍全部可选 DBX 引擎」的既有行为（可后续收成资源驱动）。
- 本期不在「打开一条未装插件的连接」上挂 ensure（函数可复用，入口第二期）。
- 不自动安装未签名本地包、不在目录中的第三方、不覆盖用户已禁用的插件。
- 不改变 bundled 第一方引擎（MySQL 等）的开箱行为。

## 背景与动机

Nacos / 全部 `cloud-*` / 知识源插件是 `distribution: download`，不随客户端打包。团队同步把 `kind=service|cloud|panel` 连接和 `database.db_type`、知识源 `plugin:<id>:` 拉过来后，工作台只认已激活插件。现有 `plugin_dbx_install_catalog_engines` 只在启动静默装目录引擎，与同步资源无关；`dependencies[]` 只解决插件装插件。

## What Changes

- 后端抽取 `collect_required_plugin_ids`（从连接 config / db_type / 知识源 source_key 反查）与 `ensure_plugins_installed`。
- 挂在 `apply_modules_bundle` 之后（桌面 client/team 模块 pull 共用）；安装失败不回滚已落地的资源。
- 解析顺序：官方目录 → 市场合并源 → DBX；bundled / 已安装跳过。
- 前端消费 ensure 结果：第一方 toast；第三方走已有权限确认框；找不到包时模块空态「去安装」。
- 新增 IPC 返回缺件安装摘要（已装 / 待确认 / 失败 / 未找到），不 **BREAKING** 既有 pull 字段（增量）。

## Capabilities

### New Capabilities

- `sync-plugin-ensure`: 资源驱动的缺件收集、分级安装（第一方静默 / 第三方确认 / 未找到不阻断）、同步后 UI 反馈。

### Modified Capabilities

- `plugin-distribution`: 允许官方第一方与 DBX 在资源同步触发时跳过插件中心权限确认 step；第三方仍须确认。

## Impact

- 后端：`src-tauri/src/commands/`（plugin ensure、client_sync_modules、team_sync）；复用 `plugin_official_install` / `plugin_install_version` / `plugin_dbx_install`。
- 前端：`clientSync` 收尾、插件确认对话框、模块/云/库空态、i18n 中英。
- Web 版：无 QuickJS 的 kind（module/cloud L2）跳过安装，仍落资源。
- 测试：收集函数单测、ensure 分级单测、前端空态 / toast。

## 成功标准

- 设备 B 拉取含 Nacos 连接 + 阿里云账户 + Oracle 库的快照后，三个对应插件在本机变为已安装并出现入口（网络与目录可用时）。
- 第三方市场包弹出权限确认，取消则不装，连接仍在。
- 目录没有的 pluginId 不导致 pull 失败；空态可点去插件中心。
- `cargo test` 相关包通过；`frontend && npx tsc -b` 零 error。
