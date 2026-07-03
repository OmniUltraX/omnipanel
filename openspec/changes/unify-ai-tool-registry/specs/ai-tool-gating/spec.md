## ADDED Requirements

### Requirement: 内部工具启用开关

系统 SHALL 以 `internal_enabled` 控制工具是否被内部 AI 编排（HTTP DirectInject 与 ACP client-tools）加载注入模型。仅当 `internal_enabled` 为真且所属模块处于 open 状态时，工具才被视为「内部可用」并注入。

#### Scenario: 禁用工具不注入

- **WHEN** 某工具 `internal_enabled` 为假
- **THEN** 该工具 MUST NOT 出现在任何内部 AI 路径注入模型的工具清单中

#### Scenario: 模块关闭时工具不可用

- **WHEN** 工具 `internal_enabled` 为真但其所属模块处于非 open 状态
- **THEN** 该工具 MUST 被判定为不可用且不注入

### Requirement: 对外暴露开关

系统 SHALL 以 `external_exposed` 控制工具是否经 OmniMCP 对外暴露。设置 `external_exposed` 为真 MUST 要求所属模块处于 open 状态；对外暴露判定为 `external_exposed` 且模块 open。

#### Scenario: 模块关闭时不能开启对外暴露

- **WHEN** 用户尝试对一个所属模块未 open 的工具开启 `external_exposed`
- **THEN** 系统 SHALL 拒绝并返回明确错误

#### Scenario: 对外列表按暴露开关过滤

- **WHEN** OmniMCP 对外列出可调用工具
- **THEN** 仅包含 `external_exposed` 为真且模块 open 的工具

### Requirement: 模块与工具双向联动

系统 SHALL 在模块状态变化时同步工具可用性：模块被关闭时，其下工具的 `internal_enabled` MUST 被置为禁用；模块重新 open 时，因模块关闭而被动禁用的工具 SHALL 恢复为可用，用户主动禁用的工具保持禁用。

#### Scenario: 关闭模块批量禁用

- **WHEN** 某模块从 open 变为非 open
- **THEN** 该模块下所有工具的 `internal_enabled` MUST 被置为假

#### Scenario: 重开模块恢复被动禁用的工具

- **WHEN** 某模块从非 open 恢复为 open
- **THEN** 此前因该模块关闭而被动禁用的工具 SHALL 恢复 `internal_enabled` 为真
- **AND** 用户在其他时机主动禁用的工具保持禁用状态

### Requirement: 系统工具纳入统一治理

系统 SHALL 将 `load_skill` 等系统级工具纳入 `ToolSpec` 与工具注册表统一管理，使其具备明确的模块归属与可预期的可用性判定，MUST NOT 在装配工具清单时无条件、绕过开关地追加。

#### Scenario: load_skill 出现在工具清单来源中

- **WHEN** 系统装配内部工具清单
- **THEN** `load_skill` 通过统一 registry 流程产出，其可用性遵循既定判定规则
- **AND** 不存在绕过 registry 的无条件追加逻辑

### Requirement: 移除遗留 enabled 双写

系统 SHALL 停止对遗留 `enabled` 列与 `internal_enabled` 的双写依赖，工具启用判定 MUST 仅以 `internal_enabled` 为准，避免语义歧义。

#### Scenario: 仅以 internal_enabled 判定

- **WHEN** 系统判断工具是否启用
- **THEN** 判定 MUST 只读取 `internal_enabled`
- **AND** 不再依赖 `enabled` 列的值
