## ADDED Requirements

### Requirement: 冻结的云能力标识

系统 SHALL 将云产品识别为开放字符串能力 id，至少包括：`compute`、`compute.lite`、`objectStorage`、`domains`、`dns`、`certs`、`cdn`。系统 MUST 将 `compute` 与 `compute.lite` 视为互不相同的能力。系统 MUST NOT 以厂商产品名（如 `ecs`、`cvm`）作为 Host 树节点类型或 Dock Tab 类型。`domains` MUST 表示域名注册资源，MUST NOT 与 `dns`（托管区/解析）视为同一能力。

#### Scenario: 轻量与云服务器分列

- **WHEN** 某云插件同时声明 `compute` 与 `compute.lite`
- **THEN** Host MUST 在账户下展示两个能力节点
- **AND** MUST NOT 将二者合并为单一「计算」列表

#### Scenario: 未声明的能力不出现

- **WHEN** 插件清单未声明 `cdn`
- **THEN** 该账户树 MUST NOT 出现 CDN 能力节点
- **AND** MUST NOT 因此新增插件 kind

### Requirement: 规范化资源行

系统 SHALL 使用统一 `CloudResourceRow`（至少含 `id`、`name`，可选 `status`、`region`、`publicIp`、`privateIp`、`endpoint` 及开放 `extra`）作为列表与树实例节点的数据。计算类加入 SSH MUST 仅依赖行上的主机地址字段，MUST NOT 依赖 `ecs` 字面量。对象存储加入文件 MUST 仅依赖 bucket 标识与 endpoint 类字段。

#### Scenario: 加入 SSH 不认产品名

- **WHEN** 用户对一条 `compute` 或 `compute.lite` 行执行宿主动作 `addSsh`，且行含可用公网或内网 IP
- **THEN** 系统 MUST 创建或复用 SSH 连接并写入 `externalSource { pluginId, accountId, remoteId, remoteKind }`
- **AND** `remoteKind` MUST 为能力 id（`compute` 或 `compute.lite`），MUST NOT 为 `ecs`/`swas` 作为唯一合同

#### Scenario: 地域是行属性

- **WHEN** 资源行带有 `region`
- **THEN** Host MUST 可将其显示为标签或列
- **AND** MUST NOT 要求该地域成为树的父节点

### Requirement: Driver 方法集

系统 SHALL 经宿主泛化入口调用插件方法：`testAccount`、`listRegions`、`listResources`、`getResource`、`invokeAction`。凭据 MUST 在 commands 层从 Vault 解析后交给 Driver，MUST NOT 把 AccessKey Secret 交给前端。`listRegions` 返回的每条地域 MUST 含 `capabilities: string[]`，MUST NOT 使用 `hasEcs`/`hasSwas` 作为合同字段。

#### Scenario: 列表按能力查询

- **WHEN** Host 请求某账户的 `compute` 列表并带地域筛选
- **THEN** 系统 MUST 调用该账户 `pluginId` 对应 Driver 的 `listResources`，capability 为 `compute`
- **AND** MUST NOT 调用已删除的产品级命令作为主路径

#### Scenario: 未知厂商拒绝

- **WHEN** 连接的 `pluginId`/`provider` 没有已登记且已激活的 cloud Driver
- **THEN** 系统 MUST 返回明确错误
- **AND** MUST NOT 默认落到阿里云客户端

### Requirement: 动作分档与生产确认

插件清单 MUST 按能力声明可展示的 `actions`。宿主动作（`addSsh`、`addToFiles`）由 Cloud Host 执行。插件动作（至少包括计算类 `start`、`stop`、`reboot`）MUST 经 `invokeAction`。当目标账户或资源环境为 `prod` 且动作为写操作时，系统 MUST 走既有生产确认，MUST NOT 可配置绕过。成功与失败 MUST 写 audit（含 `pluginId` 与 action 名，不含密钥）。

#### Scenario: 生产环境停机需确认

- **WHEN** 用户对 `env_tag=prod` 的云账户下某计算实例发起 `stop`
- **THEN** 系统 MUST 先弹出生产确认
- **AND** 用户取消后 MUST NOT 调用云厂商 API

#### Scenario: 未声明动作不展示

- **WHEN** 插件未为 `objectStorage` 声明 `start`
- **THEN** 对象存储列表与详情 MUST NOT 显示开机按钮
