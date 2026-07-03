## ADDED Requirements

### Requirement: HTTP DirectInject 路径共用 registry 工具

系统 SHALL 在 HTTP DirectInject 路径下从统一 registry 获取工具清单与 schema 注入模型，工具集合按 `internal_enabled` 与模块 open 状态过滤。

#### Scenario: HTTP 路径注入完整参数 schema

- **WHEN** 通过 HTTP 直连模型（如 DeepSeek）发起带工具的对话
- **THEN** 注入的每个工具定义参数 schema MUST 来自 registry（即 spec/DB 单一真相源）
- **AND** 模型据此产生的 `tool_calls` 参数包含 schema 声明的必填字段

### Requirement: ACP client-tools 路径动态化

系统 SHALL 让 ACP client-tools 路径的可用函数清单与 compact schema 从统一 registry 动态生成，并尊重 `internal_enabled` 与模块 open 过滤，MUST NOT 使用硬编码的单一工具清单。

#### Scenario: ACP 清单随开关变化

- **WHEN** 在 ACP 路径发起对话且多个工具处于内部可用状态
- **THEN** 注入的可用函数清单 MUST 包含这些工具（不再仅限终端工具）
- **AND** 被禁用或模块关闭的工具不出现在清单中

#### Scenario: ACP 与 HTTP 工具名与必填字段一致

- **WHEN** 同一工具分别经 ACP 与 HTTP 路径注入
- **THEN** 工具名与必填参数字段 MUST 一致

#### Scenario: 修复 prompt 拼接缺陷

- **WHEN** 构造 ACP client-tools prompt
- **THEN** 结尾指令行 MUST 只出现一次，不得重复拼接

### Requirement: OmniMCP 对外列表由 spec 派生

系统 SHALL 让 OmniMCP 对外暴露的工具列表由统一 spec 派生并按对外暴露判定过滤，消除「设置项承诺可暴露但实际不可用」的不一致。

#### Scenario: 对外列表与暴露开关一致

- **WHEN** 客户端经 OmniMCP 列出工具
- **THEN** 列表 MUST 与 `external_exposed` 且模块 open 的工具集合一致
- **AND** 未实现对外执行的工具不在设置页被标示为可暴露

### Requirement: 统一工具结果回传通道

系统 SHALL 对需前端执行的工具（ui-delegated）统一采用挂起—回传通道：后端挂起等待，前端分派执行后经结果回传命令解除挂起；该通道对 HTTP 与 ACP 路径一致。

#### Scenario: 前端执行后回传解除挂起

- **WHEN** 一个 ui-delegated 工具被模型调用
- **THEN** 后端 SHALL 挂起该工具调用并等待前端结果
- **AND** 前端完成执行并回传结果后，后端据此继续本轮编排

#### Scenario: 工具执行超时有界

- **WHEN** ui-delegated 工具在设定时限内未收到前端结果
- **THEN** 后端 SHALL 以超时结果结束该次挂起，不无限阻塞
