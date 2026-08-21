## ADDED Requirements

### Requirement: 七种插件身份

系统 SHALL 仅识别以下插件 kind：`engine`、`panel`、`importer`、`cloud`、`module`、`theme`、`addon`。系统 MUST NOT 为单一产品（翻译、Nacos、CDN、计算器）新增第 8 种 kind。

#### Scenario: 未知 kind 拒绝装载

- **WHEN** 清单中的 `kind` 不属于上述七种
- **THEN** Runtime MUST 拒绝激活该插件
- **AND** 向用户展示可理解错误（走 i18n）

#### Scenario: 中间件控制台使用 module

- **WHEN** 需要接入 Nacos / Kafka 等自带工作台、与内核交集少的能力
- **THEN** 该插件 MUST 使用 `kind: module`
- **AND** MUST NOT 要求新增 kind

### Requirement: 插件清单与生命周期

系统 SHALL 以 `PluginManifest`（id、version、kind、contributes、permissions）为装载合同。第一方插件 MUST 在启动时登记；用户禁用后 MUST 调用 deactivate 并卸除贡献点，已写入的 Connection 数据 MUST 保留。

#### Scenario: 禁用后贡献点消失

- **WHEN** 用户将某 `module` 插件设为 closed 或 disabled
- **THEN** 其侧栏入口、菜单项、启动器前缀、AI 工具 MUST 不再出现
- **AND** 该插件创建的 `kind=service` 连接仍可在存储中查询

#### Scenario: 模块插件默认不占侧栏

- **WHEN** 新的 `module` 插件首次被 `repair_app_modules` 补种
- **THEN** 其 `AppModule` 状态 MUST 为 `closed`
- **AND** 用户显式 open 后才出现在侧栏

### Requirement: 权限闸

系统 SHALL 按清单 `permissions` 强制 Host API。缺少声明的权限时 API MUST 失败，MUST NOT 静默成功。凭据 MUST 只经 Vault，插件 MUST NOT 直读 sqlite 或任意 `credential_ref`。

#### Scenario: 无写连接权限

- **WHEN** 插件未声明 `connections:write` 却调用 upsert 连接
- **THEN** Host MUST 返回错误
- **AND** MUST NOT 写入 connections 表

#### Scenario: 发现扫描需 ssh:exec

- **WHEN** 插件对 SSH 主机执行 probe（端口/进程/HTTP 探测）
- **THEN** 清单 MUST 含 `ssh:exec`
- **AND** 生产环境（`env_tag=prod`）主机 MUST 走既有确认策略后方可扫描

#### Scenario: 主题包无权限

- **WHEN** 激活 `kind: theme` 的默认主题包
- **THEN** 其 `permissions` MUST 为空
- **AND** 系统 MUST NOT 为其授予网络或 Vault 访问

### Requirement: 第一方装载

系统 SHALL 在构建期装载仓库 `plugins/` 下的第一方插件，与宿主使用同一清单合同。本期 MUST NOT 要求动态加载原生动态库。

#### Scenario: 启动列出第一方插件

- **WHEN** 应用启动并完成 Runtime 初始化
- **THEN** `plugin_list` MUST 包含已编译的第一方插件（含 id、kind、enabled）
- **AND** 前端 MUST 经 specta `bindings` 调用，禁止手写命令字符串

### Requirement: 平台过滤

系统 SHALL 支持清单字段 `platforms`（如 `windows` / `macos` / `linux`）。当前操作系统不在列表中时 Runtime MUST NOT activate 该插件，MUST NOT 登记其 AI 工具与启动器前缀；`plugin_list` MUST 仍返回该插件并标记不可用原因。

#### Scenario: 非 Windows 不激活 Everything

- **WHEN** 当前操作系统不是 Windows 且 Everything 插件声明 `platforms: ["windows"]`
- **THEN** 该插件 MUST 保持未激活
- **AND** 模型工具清单 MUST NOT 包含 `omni_everything_search`
