## ADDED Requirements

### Requirement: 启动器前缀

当 `omni.module.nacos` 已激活，系统 SHALL 由该插件登记快捷启动前缀 `nacos`。结果 MUST 在启动器结果区展示，MUST NOT 新开 WebView 窗口。禁用插件后此前缀 MUST 消失。

#### Scenario: 输入 nacos 命中实例

- **GIVEN** 存在已保存的 Nacos service 连接
- **WHEN** 用户在快捷启动输入 `nacos` 加连接名片段
- **THEN** 结果 MUST 由 Nacos provider 提供并指向该实例

#### Scenario: 禁用后前缀不可用

- **WHEN** 用户禁用 `omni.module.nacos`
- **THEN** 输入 `nacos` MUST 不再由该插件提供结果

### Requirement: 只读 OmniMCP 工具

系统 SHALL 经清单 `contributes.ai.tools` 登记只读工具：`omni_nacos_list_namespaces`、`omni_nacos_get_config`、`omni_nacos_search_configs`、`omni_nacos_list_services`。工具 `external_exposed` MUST 默认为 false。执行 MUST 走 `(plugin_id, tool.name)` 网关，MUST NOT 在 `ai_chat.rs` 为 Nacos 写死 match。

#### Scenario: 模型可读配置

- **WHEN** 已启用插件且模型调用 `omni_nacos_get_config` 并提供连接与 dataId/group
- **THEN** 系统 MUST 返回该配置内容
- **AND** 调用 MUST 记 audit（pluginId 与参数摘要，可含 dataId，不含策略要求禁止的密钥）

#### Scenario: 禁用后工具消失

- **WHEN** 用户禁用 `omni.module.nacos`
- **THEN** 随后一轮 AI 装配 MUST NOT 再注入上述 Nacos 工具

### Requirement: 写操作不对 AI 开放

系统 MUST NOT 将 `publishConfig`、`deleteConfig`、`rollbackConfig`、`updateInstance`、命名空间写方法登记为默认 AI 工具。模型需要变更时 MUST 只建议，由用户在工作台确认执行。

#### Scenario: 模型清单无发布工具

- **WHEN** 插件已启用并同步 AI 工具
- **THEN** 可调用清单 MUST NOT 包含发布、删除、回滚或改实例的工具名
