## ADDED Requirements

### Requirement: 任务中心三栏信息架构
任务中心（路由 `/tasks`）MUST 仅以「运行中」「待办」「历史」作为一级导航语义；MUST NOT 将实时审批队列作为待办一级入口。

#### Scenario: 用户打开任务中心
- **WHEN** 用户进入 `/tasks`
- **THEN** 可见运行中、待办、历史三类一级入口，并能区分正在执行的任务与可延后处理的事项

#### Scenario: 审批不出现在待办列表
- **WHEN** AI ToolGate 产生一条待确认操作（ActionDraft）
- **THEN** 该条 MUST NOT 出现在待办列表中
- **AND** 可在 AI 侧栏或关联运行中任务上以「等待确认」实时展示

### Requirement: 运行中展示被动与主动任务
运行中视图 MUST 展示被动长任务（各模块 WorkerPool / 工作流执行等）与主动任务（Loop Run）；用户 MUST 能筛选或识别二者。

#### Scenario: 模块长任务出现在运行中
- **WHEN** 数据库导出或同步等后台任务处于 pending/running
- **THEN** 运行中列表 MUST 显示该被动任务及其进度

#### Scenario: Loop 运行出现在运行中
- **WHEN** 用户或调度触发一次 Loop Run 且尚未结束
- **THEN** 运行中列表 MUST 显示该主动任务及阶段/状态摘要

### Requirement: 待办仅含可延后事项
待办视图 MUST 仅包含可延后处理的建议或 Finding（如清理、优化、巡检异常）；MUST NOT 包含阻塞 AI 工具链的实时审批项。

#### Scenario: Finding 进入待办
- **WHEN** Loop 产生 status 为 open（或等价未完成）的 Finding
- **THEN** 待办列表 MUST 展示该事项，含标题、严重级别与建议摘要（若有）

### Requirement: 定义与运行分离
工作流定义编辑与 Loop Spec 完整配置 MUST 保留在各自定义入口（如 `/workflow` 或专用配置）；任务中心 MUST 以运行实例与待办为主，MAY 提供跳转到定义页的链接。

#### Scenario: 工作流执行在任务中心可见
- **WHEN** 一次工作流执行开始
- **THEN** 其运行实例 MUST 作为被动任务出现在运行中，结束后可在历史中检索
- **AND** 步骤编辑仍在工作流模块完成

### Requirement: 快捷入口收敛到任务中心
状态栏后台任务浮窗与 AI 侧栏中的「打开任务/面板」类操作 MUST 导航至任务中心完整视图，MUST NOT 暗示存在第二套互不相同的全量任务列表。

#### Scenario: AI 侧栏打开任务中心
- **WHEN** 用户在 AI 任务摘要区点击打开任务中心
- **THEN** 应用 MUST 进入 `/tasks`（或等价任务中心路由）

### Requirement: 生产环境确认策略不变
任务中心的展示与导航 MUST NOT 绕过各模块既有的生产环境（prod）二次确认与危险操作拦截。

#### Scenario: 从待办发起高风险动作
- **WHEN** 用户从待办建议触发需要写操作的执行路径
- **THEN** 系统 MUST 仍经过既有确认/审批闸（ToolGate 或模块确认），不得静默执行
