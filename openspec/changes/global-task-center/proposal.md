## Why

当前「任务中心」把长任务、AI 审批闸、Loop 巡检、Finding 分诊、审计与 AI Trace 塞进同一套并列 Tab，入口还与状态栏浮窗、AI 侧栏三重重叠，用户无法理解它解决什么问题。与此同时 PRD（§3.0 任务中心、§5.6 关键页面）要求的是：**全局长任务观测 + 可延后待办 + 统一复盘**，而不是审批箱或工作流编辑器。现在收口信息架构并建立统一运行投影，才能让 `/tasks` 成为真正的全局任务中心。

## 目标

- 将任务中心打造成**全局运行观测与延后事项入口**：被动长任务、主动 Loop 运行、可延后待办、统一历史时间轴。
- 明确语义边界：**审批闸实时、超时收口、只留痕不进待办**；**待办 = 可延后建议/Finding（可合并）**。
- **工作流 / Loop 定义层保持独立模块**；其**执行实例**进入任务中心运行中与历史。
- 收敛重复入口：任务中心为完整真相源；状态栏/AI 侧栏降为快捷入口。

## 非目标（Non-goals）

- 不把工作流步骤编辑器、Loop Spec 完整配置器并入任务中心（定义仍在 `/workflow` 与 Loop 配置入口）。
- 不把 ActionDraft 审批队列改造成待办 Inbox。
- 本期不新建「项目 Project」实体；分组维度优先用 `module` / `workspaceId` / `resourceId`。
- 不一次性重写所有模块的任务提交 API；以统一投影 + 分阶段接入为主。
- 不在本期改造 AI Trace 存储模型本身（只将其挂入时间轴展示）。

## 背景与动机

- **现状**：`backgroundTaskStore`（WorkerPool，终态约 8s 丢弃）、`actionDraftStore`（审批闸）、`loopStore`（IndexedDB）、`aiOrchestrationStore`、SQLite `audit_log` / `builtin_tool_audit` / `ai_sessions`+`ai_traces`、以及未接通真实执行的 Workflow UI 并行存在。
- **错位**：Pending Tab 实际是审批；Triage/Loops 与「长任务」并列；Workflow 执行未进任务中心；历史三页签无法按功能/工作区/资源分组。
- **已拍板产品划分**（对话确认）：
  1. 被动任务 = 各模块长任务（含 Workflow 执行）。
  2. 主动任务 = Loop Run 及结果。
  3. 待办 = 延后类建议/Finding，重复自动合并。
  4. 审批 = 实时门禁，超时拒绝/终止/挂起，历史留痕，不进待办。
  5. 工作流与 Loop **定义分离、运行归中心**。

影响 Phase：全局能力（PRD §3.0）与模块路由 `/tasks`；关联 `/workflow`、AI 侧栏、StatusBar；不改变各模块自身执行引擎的 prod 确认策略。

## What Changes

- **信息架构重做**：任务中心 Tab 收敛为 **运行中 / 待办 / 历史**（可选筛选被动/主动）；移除「审批当待办」「Loops/Triage 并列一级」的混乱结构。
- **统一任务投影模型**：前端（及必要时 SQLite 索引）用统一 `TaskItem` 描述被动 Job、主动 Loop Run、Inbox Finding；审批仅作关联状态与历史事件。
- **被动任务历史**：WorkerPool / 模块长任务终态可检索，不再仅依赖内存 + 短时消失。
- **主动任务**：Loop Run 在「运行中/历史」可见；Finding 进入「待办」，按 fingerprint 合并。
- **审批策略产品化**：超时自动拒绝（默认）；可扩展终止上游 / 挂起；结果写入历史，不进待办列表。
- **工作流运行接入**：接通真实 `workflowRun` 后，执行实例作为被动任务出现在任务中心；定义编辑仍在工作流模块。
- **历史时间轴**：合并任务终态、审批结果、AI Session（可展开 Trace），支持按功能/工作区/资源分组或筛选。
- **入口收敛**：StatusBar 浮窗、AI 侧栏「打开任务」指向任务中心；AI 侧栏保留实时审批条。

## Capabilities

### New Capabilities

- `global-task-center`: 全局任务中心信息架构、三栏语义（运行中/待办/历史）、入口收敛与筛选分组行为。
- `unified-task-projection`: 统一任务/待办投影模型、被动与主动 Job、Finding fingerprint 合并、与审批事件的边界。
- `task-history-timeline`: 多源历史时间轴（任务终态、审批留痕、AI Session/Trace）、按 module/workspace/resource 筛选或分组。

### Modified Capabilities

<!-- openspec/specs/ 目前为空，无既有能力被修改。 -->

## 成功标准

- 用户打开 `/tasks` 能在 10 秒内理解：哪里看正在跑的、哪里看可延后建议、哪里翻历史。
- 审批超时后不残留在待办；历史中可查到拒绝/超时记录。
- 同一资源重复巡检建议在待办中合并为一条（带出现次数），不无限堆叠。
- 数据库导出/同步、Loop Run、（接通后的）Workflow 执行至少各有一类出现在「运行中→历史」闭环。
- 状态栏/AI 侧栏不再维护与任务中心冲突的「第二套全量列表」叙事（快捷入口可保留）。

## Impact

- **前端**：`frontend/src/modules/tasks/*`、`TaskCenterSidebar`、相关 i18n；`backgroundTaskStore` 终态策略；`loopStore` 去重；`AiTaskAndDraftPanel` / `BackgroundTasksWindow` 入口文案与跳转；可选 Workflow「运行」接通。
- **后端（分阶段）**：WorkerPool 终态持久化或 `task_events` 索引表；`workflow_run` 事件投影；审计/会话列表筛选字段补齐（workspace/resource，按阶段）。
- **存储**：Loop IndexedDB；可能新增 SQLite 任务事件表；不迁移遗留 `tasks` 表为唯一模型（可标记 deprecated 或后续接入）。
- **模块路由**：`/tasks` 主改；`/workflow` 保留定义；AI Drawer、StatusBar 联动。
- **环境与确认**：各模块 prod/危险操作仍走既有 ToolGate / ExecutionEngine；本变更不削弱确认，只澄清「确认 ≠ 待办」。
