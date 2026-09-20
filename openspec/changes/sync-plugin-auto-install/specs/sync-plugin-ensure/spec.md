## ADDED Requirements

### Requirement: 同步后按资源收集缺件插件

系统 SHALL 在模块快照应用到本机后，从下列资源收集所需插件 id（去重、忽略空值）：`kind=service` 的 `config.pluginId`；`kind=cloud` 的 `config.pluginId`（含旧别名升格）；`kind=panel` 的 `config.serviceType`（含 `bt`/`1panel` 等别名）；数据库连接 `db_type`（第一方 bundled 引擎 MUST 跳过，其余映射为 `omni.engine.<canonical>`）；知识源 `source_key` 形如 `plugin:<plugin_id>:<source_id>`。已在插件 registry 中的 id（bundled 或已安装，含已禁用）MUST 跳过，不得自动重新启用。

#### Scenario: 同步下来的 Nacos 与阿里云被收集

- **WHEN** 本机存在 `kind=service` 且 `pluginId=omni.module.nacos` 的连接，以及 `kind=cloud` 且 `pluginId=omni.cloud.aliyun` 的连接，且两者均未安装
- **THEN** 收集结果包含这两个 id

#### Scenario: 第一方 MySQL 不进入安装列表

- **WHEN** 本机仅有 `db_type=mysql` 的数据库连接
- **THEN** 不收集 `omni.engine.mysql`，不触发下载

#### Scenario: 达梦别名归一

- **WHEN** 数据库连接 `db_type=dm`
- **THEN** 收集 `omni.engine.dameng`

#### Scenario: 已禁用插件不自动启用

- **WHEN** 所需插件已在 registry 但 `enabled=false`
- **THEN** 该 id 记为 skipped，不调用安装或 `plugin_set_enabled`

### Requirement: 分级安装且不阻断同步

系统 SHALL 提供 `plugin_ensure_from_resources`（specta 生成 bindings）。对未跳过的 id：官方目录 `distribution=download` MUST 静默走 `plugin_official_install`；非第一方且 DBX 目录有对应 driver MUST 静默走 `plugin_dbx_install`；市场合并源且 `sourceId` 非官方 MUST 列入 `pendingConfirm`，仅当请求 `approveIds` 包含该 id 时才安装；任何目录都没有 MUST 列入 `notFound`。单包失败 MUST 记入 `failed` 并继续其余项。ensure 失败 MUST NOT 回滚已落地的连接或凭据。生产环境资源上的写操作仍走既有 `env_tag=prod` 确认，本命令不得执行那些写操作。

#### Scenario: 官方插件静默安装成功

- **WHEN** 收集到未安装的 `omni.module.nacos` 且官方目录可下载
- **THEN** 无需前端确认即安装成功，结果 `installed` 含该 id，并经 `plugin://changed` 同步多窗

#### Scenario: 第三方需确认

- **WHEN** 收集到仅存在于非官方市场源的插件且本次 `approveIds` 为空
- **THEN** 不安装该包，结果 `pendingConfirm` 含 id、名称、权限列表

#### Scenario: 确认后安装第三方

- **WHEN** 用户确认后再次调用且 `approveIds` 含该第三方 id
- **THEN** 按市场安装路径装上（含已批准的依赖）

#### Scenario: 目录没有也不阻断

- **WHEN** 收集到的 id 在官方、市场、DBX 均不存在
- **THEN** pull/ensure 整体成功，`notFound` 含该 id，对应连接仍保留在本机

#### Scenario: 凭据不因安装失败丢失

- **WHEN** 某个插件下载失败
- **THEN** 已应用的模块快照与 Vault 凭据保持不变，仅该 id 出现在 `failed`

### Requirement: 同步后的用户反馈

前端 MUST 在模块快照 UI 刷新之后调用 ensure。已安装第一方 MUST toast 摘要；`pendingConfirm` MUST 弹出权限确认（幽灵操作按钮，与插件中心一致）；用户取消则不装。`notFound` / `failed` MUST 提示且不删除资源。模块工作台在插件未激活时 MUST 提供「去安装」进入插件中心。

#### Scenario: 同步后看到已装摘要

- **WHEN** ensure 安装了 Nacos 与阿里云
- **THEN** 用户看到一条已自动安装的 toast，对应模块入口随后可用

#### Scenario: 取消第三方确认

- **WHEN** 确认框点取消
- **THEN** 不调用带 `approveIds` 的第二次 ensure，连接仍在

#### Scenario: 模块空态去安装

- **WHEN** 模块 Host 已挂载但插件未激活
- **THEN** 空态展示去安装操作，点击进入 `/plugins`
