## ADDED Requirements

### Requirement: Nacos 作为官方 module 狗粮包

`omni.module.nacos` MUST 以与第三方相同的包形状交付：`plugin.json` 声明 `module.capabilities`（`namespace`/`config`/`discovery`/`cluster`）+ `entry.logic`。实现 MUST 在 L2 `logic.js`，MUST NOT 以 `omnipanel-nacos` crate 或插件内 React 为装载前提。同一目录 MUST 可被 `pack` 打成 `.omni-plugin`。

#### Scenario: 狗粮包可被打包

- **WHEN** 对 `plugins/module-nacos` 执行官方 pack
- **THEN** 产出 MUST 含清单与 `logic.js` 且通过验签
- **AND** 清单 MUST 声明上述四种能力与写方法 dangerAction

### Requirement: 1.x 与 2.x 均可连接

系统 SHALL 将 Nacos 1.x 与 2.x 视为一等公民，通过同一组 L2 methods 访问。逻辑包 MUST 在 `testConnection` 或首次请求时探测方言与鉴权模式（无认证 / 用户名密码 token）。用户可锁定 `dialect=v1|v2`；`auto` 失败 MUST 返回可理解错误。系统 MUST NOT 将无法识别的主版本（含 3.x）当作 2.x 执行写方法。

#### Scenario: 无认证 1.x 测通

- **WHEN** 用户填写一台关闭鉴权的 Nacos 1.x 地址并测试连接
- **THEN** `testConnection` MUST 成功
- **AND** 概览 MUST 标明方言为 v1 且鉴权为 none

#### Scenario: 有认证 2.x 测通

- **WHEN** 用户填写 Nacos 2.x 的 host 与账号密码并测试连接
- **THEN** 客户端 MUST 登录取得 accessToken 并调用成功
- **AND** 密码 MUST 只存在 Vault，不出现在连接 config

#### Scenario: 未识别版本拒绝写入

- **WHEN** 探测结果不是 1.x 或 2.x
- **THEN** 读方法可失败并提示不受支持
- **AND** `publishConfig` / `rollbackConfig` / `deleteConfig` / `updateInstance` MUST 被拒绝

### Requirement: 凭据与权限

Nacos 插件 MUST 声明 `net:connect` 与 `vault:read`；写连接另需 `connections:write`。缺权调用 MUST 失败且写入 audit。accessToken MUST 只留在 L2/宿主秘密通道，MUST NOT 回传前端明文。

#### Scenario: 缺网权不能列配置

- **WHEN** 清单去掉 `net:connect` 后调用 `listConfigs`
- **THEN** 网关 MUST 以缺权失败
- **AND** audit MUST 记录 `plugin.permission/blocked` 与 pluginId

### Requirement: 命名空间

系统 SHALL 列出、创建、更新、删除命名空间，并在工作台以实例级筛选切换当前 `namespaceId`。删除与创建 MUST 视为写操作。

#### Scenario: 切换命名空间刷新列表

- **WHEN** 用户在已连接实例上选择另一命名空间
- **THEN** 配置列表与服务列表 MUST 按该 namespace 重新加载
- **AND** 连接上的默认 `namespaceId` MUST 可被保存以便下次打开

### Requirement: 配置读写与发布

系统 SHALL 支持按 dataId/group 搜索与列出配置、读取内容、用现有文本编辑器编辑、发布与删除。发布与删除 MUST 为危险写操作。

#### Scenario: 发布配置

- **WHEN** 用户编辑一条配置并确认发布
- **THEN** 系统 MUST 调用 `publishConfig` 且远端可读到新内容
- **AND** 成功 MUST 写 audit（pluginId、dataId、group、namespace，不含全文）

#### Scenario: 生产实例发布需确认

- **GIVEN** 该 service 连接 `env_tag=prod`
- **WHEN** 用户请求发布或删除配置
- **THEN** 系统 MUST 走既有生产确认（及已落地的 step-up）
- **AND** 用户拒绝或超时 MUST 不调用远端写接口

### Requirement: 配置历史与回滚

系统 SHALL 列出配置历史、查看某一历史版本内容，并允许回滚。回滚 MUST 为危险写操作，prod 规则与发布相同。

#### Scenario: 回滚到历史版本

- **WHEN** 用户从历史列表选择一版并确认回滚
- **THEN** 远端当前配置 MUST 等于该历史内容
- **AND** audit MUST 记录回滚动作与目标版本标识，不含全文

### Requirement: 服务与实例

系统 SHALL 列出服务与实例（含健康、地址、权重、启用状态），并允许更新实例启用状态与权重。`updateInstance` MUST 为危险写操作，prod 规则与发布相同。

#### Scenario: 列出服务实例

- **WHEN** 用户打开某服务
- **THEN** 系统 MUST 展示其实例的地址、健康与权重

#### Scenario: 生产环境下线实例需确认

- **GIVEN** 连接 `env_tag=prod`
- **WHEN** 用户将某实例设为禁用
- **THEN** 系统 MUST 先确认再调用 `updateInstance`
- **AND** 拒绝时远端状态 MUST 不变

### Requirement: 集群节点

系统 SHALL 展示集群节点列表与健康摘要（只读）。节点接口失败 MUST 不阻断配置与服务工作台。

#### Scenario: 概览显示节点

- **WHEN** 用户打开实例概览且节点接口可用
- **THEN** 概览 MUST 显示节点数量与健康摘要

### Requirement: 无认证生产警告

系统 SHALL 允许无认证集群使用 `env_tag=prod`，但 MUST 在概览给出明文警告；其写操作仍 MUST 走生产确认。

#### Scenario: 无认证 prod 仍要确认

- **GIVEN** 无认证集群且 `env_tag=prod`
- **WHEN** 用户发布配置
- **THEN** 系统 MUST 仍然弹出生产确认
- **AND** 概览 MUST 可见无认证警告
