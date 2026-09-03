## ADDED Requirements

### Requirement: 扫描归属 Nacos 插件

系统 SHALL 将 Nacos 发现 probe 登记在 `omni.module.nacos` 的 `contributes.discovery` 与 activate mapper 上。未激活该插件时 MUST NOT 提供「扫 Nacos」入口。扫描 MUST 复用现有发现总线与 `ImportPreview`，MUST NOT 另建任务系统。

#### Scenario: 禁用后无扫描入口

- **WHEN** 用户禁用 `omni.module.nacos`
- **THEN** 模块壳与 SSH/Docker 发现入口 MUST 不再出现 Nacos 扫描项

### Requirement: SSH 与 Docker 探测

系统 SHALL 在用户确认的 SSH 或 Docker 范围内探测常见 Nacos HTTP 端口（至少 8848）及 `contextPath` 健康端点。命中 MUST 规范化为 `Candidate`（`pluginId=omni.module.nacos`，`remoteKind=nacos`）。9848 仅可作为辅助提示，MUST NOT 作为本期客户端传输端口。扫描需要 `ssh:exec`。

#### Scenario: 扫到 8848 生成候选

- **WHEN** 用户对一台监听 8848 且返回 Nacos 健康信息的 SSH 主机运行 Nacos 扫描
- **THEN** 预览列表 MUST 出现至少一条 Nacos 候选
- **AND** 候选 `remoteId` MUST 稳定标识 host:port

#### Scenario: 非 Nacos 端口不误报为可导入成功项

- **WHEN** 主机仅开放无关 HTTP 端口
- **THEN** 系统 MUST NOT 将其标为可导入的 Nacos 实例

### Requirement: 导入为 service 并去重

用户确认预览后，系统 MUST upsert `kind=service` 连接，写入 `externalSource { pluginId, accountId, remoteId, remoteKind }`。再同步 MUST 按该三元组匹配，MUST NOT 仅按显示名去重。模块树 MUST 立即可见新实例。

#### Scenario: 确认导入后树中可见

- **WHEN** 用户在 ImportPreview 确认一条 Nacos 候选
- **THEN** 系统 MUST 写入 `kind=service` 且 `pluginId=omni.module.nacos`
- **AND** `/module/nacos` 树 MUST 立即显示该实例

#### Scenario: 再扫不重复建连

- **WHEN** 同一 SSH 来源与同一 remoteId 再次扫描并确认
- **THEN** 系统 MUST 更新已有连接而 MUST NOT 再插入一行

### Requirement: 生产主机扫描策略

系统 SHALL 复用发现总线对 `env_tag=prod` 主机的既有跳过或确认策略。Nacos 扫描 MUST NOT 绕过该策略，MUST NOT 在未授权时对 prod 主机发起探测请求。

#### Scenario: prod 主机不偷偷探测

- **GIVEN** 目标 SSH 连接 `env_tag=prod` 且发现策略为跳过
- **WHEN** 用户启动包含该主机的 Nacos 扫描
- **THEN** 系统 MUST 不向该主机发起 Nacos 探测请求
- **AND** 结果中 MUST 可计数为已跳过

### Requirement: 扫描凭据不落明文

从扫描创建的连接 MUST 不含密码明文。无认证命中可以无 `credential_ref`；需要认证但未知口令的候选 MUST 标为需补全凭据，MUST NOT 把猜测口令写入 config。

#### Scenario: 需认证的扫描结果要补密码

- **WHEN** 健康端点表明开启鉴权但扫描未取得口令
- **THEN** 导入后的连接 MUST 可打开编辑对话框补全用户名密码
- **AND** 在补全前 `testConnection` MUST 失败并提示需要凭据
