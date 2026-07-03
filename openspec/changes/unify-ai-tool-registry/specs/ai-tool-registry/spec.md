## ADDED Requirements

### Requirement: 后端工具定义单一真相源

系统 SHALL 在后端以单一静态清单（`ToolSpec`，字段含 `name`、`module_key`、`description`、`input_schema`、`exec_kind`）集中定义全部内置 AI 工具，作为工具名称、参数 schema 与执行类型的唯一权威来源。任何路径（HTTP、ACP、OmniMCP、前端）MUST NOT 各自硬编码工具 schema。

#### Scenario: 新增或修改内置工具只改一处

- **WHEN** 开发者需要新增一个内置工具或修改其参数
- **THEN** 只需在后端 `ToolSpec` 清单中增改一条记录
- **AND** HTTP、ACP、OmniMCP 三条路径以及前端查询接口获得的工具名与参数 schema 保持一致

#### Scenario: 终端工具携带 command 参数 schema

- **WHEN** 系统装配 `omni_terminal_run_terminal_command` 的工具定义
- **THEN** 其 `input_schema` MUST 包含必填字段 `command`（string）及可选字段 `session_id`
- **AND** 注入到任意模型的该工具定义参数 schema 与此一致，不再出现空 `{}` 参数

### Requirement: 工具 schema 持久化落库

系统 SHALL 在 `mcp_tools` 表持久化每个工具的 `input_schema`，并在启动/修复时以后端 `ToolSpec` 为准写入 `description` 与 `input_schema`，同时保留用户已设置的开关字段。

#### Scenario: 旧库平滑迁移

- **WHEN** 应用在缺少 `input_schema` 列的旧数据库上启动
- **THEN** 系统 MUST 自动为 `mcp_tools` 表增加 `input_schema` 列并回填当前 spec 的 schema
- **AND** 用户既有的 `internal_enabled` / `external_exposed` 设置不被覆盖

#### Scenario: 描述与 schema 以代码为准

- **WHEN** 执行工具修复/种子写入且工具行已存在
- **THEN** 系统 SHALL 用 spec 的 `description` 与 `input_schema` 更新该行
- **AND** 不修改该行的开关状态

### Requirement: registry 装配工具定义

系统 SHALL 提供 registry 装配逻辑，从 DB 读取工具记录（含 `input_schema`）产出模型可用的工具定义（`ToolDef`），当 DB 中 schema 缺失或解析失败时回退到 spec。工具的 `exec_kind`（native / ui-delegated / external-mcp）MUST 由 spec 判定，而非独立硬编码名单。

#### Scenario: 从 DB 读取 schema 装配

- **WHEN** registry 装配某工具的 `ToolDef`
- **THEN** 其 `parameters` 取自 DB 记录的 `input_schema`
- **AND** 若 DB schema 无法解析，则回退使用 spec 中的 `input_schema`

#### Scenario: 执行类型由 spec 判定

- **WHEN** registry 判定一个工具是后端直执（native）还是需前端执行（ui-delegated）
- **THEN** 判定结果 MUST 来自该工具 spec 的 `exec_kind` 字段

### Requirement: 前端工具查询契约

系统 SHALL 通过 IPC 命令 `mcp_tool_list` 返回工具记录，且返回结构 MUST 包含 `input_schema` 字段，供前端渲染工具卡片、校验参数与展示可用性，前端无需再本地维护 schema。

#### Scenario: 列表返回带 schema

- **WHEN** 前端调用 `mcp_tool_list`
- **THEN** 每条工具记录 MUST 含 `tool_name`、`module_key`、`description`、`internal_enabled`、`external_exposed`、`input_schema`
- **AND** `input_schema` 为可被前端解析的 JSON Schema 字符串或对象
