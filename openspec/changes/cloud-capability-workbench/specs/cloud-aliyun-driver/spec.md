## ADDED Requirements

### Requirement: 阿里云作为第一方 Driver

系统 SHALL 将 `omni.cloud.aliyun` 登记为 `CloudProviderDriver` 实现，并在编译期向 `InvokeGateway` 注册合同 method。OpenAPI 签名与厂商 JSON 映射 MUST 位于阿里云插件 crate（如 `omnipanel-cloud-aliyun`），MUST NOT 作为 Cloud Host 或 specta 产品命令的主实现。桌面命令层与 server 分发层 MUST 共用该 crate，MUST NOT 再维护第二份完整 `aliyun.rs` 客户端。

#### Scenario: 列表走能力映射

- **WHEN** Host 对阿里云账户请求 `listResources` 且 capability 为 `compute`
- **THEN** Driver MUST 调用 ECS 只读列表并映射为 `CloudResourceRow`
- **AND** 前端 MUST 无需知道 `ecs` 命令名

#### Scenario: 轻量独立映射

- **WHEN** capability 为 `compute.lite`
- **THEN** Driver MUST 调用轻量（SWAS）列表 API，MUST NOT 与 ECS 共用同一请求

### Requirement: 阿里云能力声明

`plugins/cloud-aliyun` 清单 MUST 声明：`compute`、`compute.lite`、`objectStorage`、`domains`、`certs`。本期 MUST NOT 强制声明 `cdn` 或 `dns`。连接表单 MUST 声明 AccessKey 类字段与地域多选，由 Host 按 `connectionForm` 渲染。

#### Scenario: 清单驱动树

- **WHEN** 阿里云插件已激活且账户配置有效
- **THEN** 该账户下 MUST 出现 compute、compute.lite、objectStorage、domains、certs 五个能力节点（无实例时仍出现）
- **AND** MUST NOT 出现未声明的 `cdn` 节点

### Requirement: 阿里云动作

阿里云 Driver MUST 为 `compute` 与 `compute.lite` 实现 `getResource` 以及 `invokeAction` 的 `start`、`stop`、`reboot`（厂商 API 支持的范围内）。对象存储 MUST 继续支持宿主 `addToFiles`。计算实例 MUST 继续支持宿主 `addSsh`。控制台链接若厂商提供 MUST 经详情字段返回，由 Host 打开外链。

#### Scenario: ECS 停机走插件动作

- **WHEN** 用户在阿里云 ECS 详情确认执行 `stop` 且已通过环境闸
- **THEN** 系统 MUST 调用阿里云实例停止 API
- **AND** audit MUST 记录 pluginId 与 action，MUST NOT 记录 AccessKey Secret

#### Scenario: 旧产品 IPC 不再作为主路径

- **WHEN** 本变更完成
- **THEN** 前端业务 MUST NOT 调用 `cloudListEcs` / `cloudListSwas` 等产品级 bindings 作为列表主路径
- **AND** 兼容转发若短暂保留 MUST 仅映射到 `listResources`，并在任务中标明删除期限

### Requirement: 凭据与别名

阿里云账户 Secret MUST 写入 Vault，连接 config MUST NOT 长期保存明文 Secret。读取旧连接时 `provider=aliyun` MUST 解析为 `omni.cloud.aliyun`。

#### Scenario: 编辑账户保留密钥

- **WHEN** 用户编辑阿里云账户且 Secret 输入为空
- **THEN** 系统 MUST 保留 Vault 中原密钥
- **AND** 测连与列表 MUST 仍可用
