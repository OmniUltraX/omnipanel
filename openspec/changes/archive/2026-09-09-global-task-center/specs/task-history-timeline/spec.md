## ADDED Requirements

### Requirement: 统一历史时间轴
历史视图 MUST 以时间倒序（或用户可选排序）聚合已结束的被动/主动任务，并 MAY 包含审批留痕与 AI 会话摘要；各来源 MUST 以可区分的类型展示。

#### Scenario: 多源按时间排列
- **WHEN** 用户打开历史且存在已完成的导出任务、已结束的 Loop Run 与审批记录
- **THEN** 列表 MUST 按时间聚合展示，且每条可识别来源类型

### Requirement: 按功能、工作区、资源筛选或分组
历史视图 MUST 支持按功能（module/kind）、工作区（workspaceId，若有）、资源（resourceId，若有）进行筛选或分组；缺失维度的条目 MUST 仍可出现在「未分类」或全局列表中。

#### Scenario: 按模块筛选
- **WHEN** 用户选择仅查看 database 相关历史
- **THEN** 列表 MUST 只显示 module 为 database（或等价）的条目

#### Scenario: 按资源筛选
- **WHEN** 用户按某 resourceId 筛选且存在带该字段的任务
- **THEN** 列表 MUST 只显示关联该资源的条目

### Requirement: AI Session 与 Trace 挂载
历史视图 MUST 能展示 AI 会话（Session）作为可展开节点；展开后 MUST 能加载该会话的 Trace 事件；MUST NOT 强制将每条 Trace 事件与长任务平级铺满主列表（避免淹没任务终态）。

#### Scenario: 展开会话查看 Trace
- **WHEN** 用户在历史中展开一条 AI Session
- **THEN** 系统 MUST 加载并展示该 session 的 Trace 列表（或明确的空/错误状态）

### Requirement: 审批仅作为历史事件
审批确认、拒绝、超时结果 MUST 可作为历史时间轴事件出现；MUST NOT 因此在待办中创建可延后事项。

#### Scenario: 用户确认危险 SQL 后
- **WHEN** 用户确认一条高风险 SQL 审批且执行结束
- **THEN** 历史中 MUST 可查到对应审批/执行记录
- **AND** 待办列表 MUST NOT 新增该审批项

### Requirement: 审计与生产标记可见
当历史条目关联环境标签（含 prod）或风险级别时，UI MUST 展示该标签或风险提示，以便复盘时识别生产相关操作。

#### Scenario: 生产环境操作出现在历史
- **WHEN** 一条历史记录的 envTag 为 prod（或等价生产标记）
- **THEN** 界面 MUST 显示可识别的生产环境提示
