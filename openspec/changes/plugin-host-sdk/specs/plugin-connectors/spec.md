## ADDED Requirements

### Requirement: 开放引擎与面板标识

系统 SHALL 将数据库引擎 key、面板厂商 id、云厂商 id 视为开放字符串，由插件注册表解析。前端 MUST NOT 以封闭联合类型作为扩展唯一门槛（可保留已知引擎的图标别名）。

#### Scenario: 未知引擎仍可建连接

- **WHEN** 已启用的 engine 插件登记了 key `clickhouse` 且提供表单字段
- **THEN** 连接对话框 MUST 能创建 `kind=database` 且引擎为 `clickhouse` 的连接
- **AND** MUST NOT 要求修改核心 `engine: "mysql" | "postgresql" | …` 联合类型才能保存

#### Scenario: 面板 Tab 按 capabilities 出现

- **WHEN** 当前面板插件声明 `websites` 与 `apps` 但未声明 `cron`
- **THEN** Server 面板 MUST 显示网站与应用 Tab
- **AND** MUST NOT 显示计划任务 Tab

### Requirement: service 连接种类

系统 SHALL 支持 `ConnectionKind::Service`，其 `config` MUST 包含 `pluginId`。模块插件的实例 MUST 落在 connections 表，以便复用标签、分组与环境标记。

#### Scenario: 模块实例可打标签

- **WHEN** 用户为一条 `kind=service` 且 `pluginId=omni.module.nacos` 的连接添加用户标签
- **THEN** 标签 MUST 经现有 `TaggableKind::Connection` 保存
- **AND** 模块壳的标签过滤 MUST 能筛出该实例

### Requirement: 统一外部血缘

系统 SHALL 使用 `externalSource { pluginId, accountId?, remoteId, remoteKind }` 标识从云、导入器或发现产生的连接。再同步 MUST 按该三元组匹配已有行，MUST NOT 仅按显示名去重。读取时 MUST 兼容旧字段 `cloudSource`。

#### Scenario: ECS 加入 SSH 可反查

- **WHEN** 用户从阿里云 ECS 列表将实例加入终端
- **THEN** 新建或复用的 SSH 连接 MUST 带 `externalSource.pluginId` 指向云插件且 `remoteId` 为实例 id
- **AND** 同一账户同一实例再次加入 MUST NOT 再创建重复 SSH 连接

#### Scenario: 生产主机加入需确认

- **WHEN** 云账户或目标主机 `env_tag` 为 `prod` 且操作会写入可登录连接
- **THEN** 系统 MUST 走既有生产环境确认
- **AND** 凭据 MUST 写入 Vault 而非连接 config 明文

### Requirement: 云独立侧栏

系统 SHALL 提供独立模块路由 `/module/cloud` 作为 Cloud Host。Server 模块 MUST 不再将云账户树作为主入口。云产品 Tab MUST 由厂商插件的 capability 映射渲染（含 compute、objectStorage、dns、cdn、certs 等）。

#### Scenario: 侧栏可见云入口

- **WHEN** 用户将 `cloud` 模块设为 open
- **THEN** 主侧栏 MUST 显示云入口并导航到 `/module/cloud`
- **AND** 阿里云账户列表与 ECS/OSS 等 Tab MUST 在该模块内可用

#### Scenario: CDN 属于厂商插件而非新 kind

- **WHEN** 阿里云插件声明 `capability: cdn`
- **THEN** Cloud Host MUST 为该账户显示 CDN Tab
- **AND** MUST NOT 因此新增插件 kind

### Requirement: 导入与发现闭环

系统 SHALL 将发现 probe 的结果规范为 `Candidate[]`，经统一 ImportPreview（可导入 / 重复 / 不支持）后 upsert。Warpgate 类堡垒导入 MUST 将连接主机指向堡垒入口，MUST NOT 默认写成内网目标 IP。

#### Scenario: Warpgate 导入 SSH 与数据库

- **WHEN** 用户用 API Token 从 Warpgate 拉取 targets 并确认导入
- **THEN** 系统 MUST 为 SSH 与 MySQL/PostgreSQL targets 分别 upsert 对应 kind 的连接
- **AND** 每条连接 MUST 带 `externalSource` 指向 Warpgate 插件与 target id
- **AND** SSH/数据库主机 MUST 为 Warpgate 入口而非 target 内网地址

#### Scenario: 导入凭据进 Vault

- **WHEN** 导入项包含密钥或口令
- **THEN** 系统 MUST 将秘密写入 Vault 并以 `credential_ref` 关联
- **AND** config JSON MUST NOT 长期保存明文密码
