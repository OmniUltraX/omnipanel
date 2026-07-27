## Context

任务相关能力分散在多条通道：Rust `BackgroundWorkerPool` + `backgroundTaskStore`、`actionDraftStore`（ToolGate）、`loopStore`（IndexedDB）、`aiOrchestrationStore`、SQLite 审计/AI Trace、以及工作流执行表（UI 未真正调用 `workflow_run`）。`/tasks` 试图聚合它们却用错误的一级 Tab 语义，导致产品不可理解。

本设计落实已拍板划分：运行中（被动+主动 Job）、待办（延后 Finding）、历史（时间轴）；审批实时闸只留痕；Workflow/Loop **定义分离、运行归中心**。

约束：本地优先；commands 薄桥接；新 IPC 走 specta；UI 对齐 `design/tasks.html` 与 `tokens.css`；不引入重型依赖。

## Goals / Non-Goals

**Goals:**

- 前端统一投影层，把多源任务收敛为可展示的 `TaskItem`。
- 任务中心三 Tab 信息架构与入口收敛。
- Finding fingerprint 合并；被动任务终态可查。
- Workflow 执行接通后作为被动任务投影。
- 历史时间轴多源合并与 module/workspace/resource 筛选。

**Non-Goals:**

- 合并 Workflow/Loop 定义编辑器进 `/tasks`。
- 把 Draft 改造成可延后待办。
- 新建 Project 实体。
- 一期替换遗留 `crates/omnipanel-store/src/task.rs` 为唯一存储（可后续接入）。

## Decisions

### D1：统一投影在前端，权威执行仍在原引擎

- **选择**：新增 `frontend/src/modules/tasks/projection/`（或 `stores/taskCenterStore`）订阅各源，投影为 `TaskItem[]`；取消/确认仍调用原 API（`bg_task_cancel`、Draft confirm、loop triage）。
- **备选**：后端单一 Task 表接管一切执行 → 改动面过大、打断 WorkerPool/Workflow。
- **边界**：
  - **crate**：WorkerPool 终态落库、`task_events` 索引（P1+）、workflow 执行已有表。
  - **commands**：薄封装 list/history/cancel；specta 生成 bindings。
  - **frontend module `tasks`**：投影、IA、详情；模块间不互相 import，只读 store/IPC。

### D2：Facet 语义（产品硬边界）

| facet | 含义 | UI |
|-------|------|-----|
| `passive_job` | 模块长任务 / Workflow 执行 | 运行中 + 历史 |
| `active_job` | Loop Run | 运行中 + 历史 |
| `inbox` | Finding / 延后建议 | **仅待办** |
| `approval` | ToolGate Draft | **不进待办**；可在关联 Job 上显示「等待确认」；历史留痕 |

审批超时默认 **reject**（保留现有 ~120s）；后续可按 kind 配置 terminate / suspend。

### D3：Finding 合并键

```
fingerprint = hash(loopId | resourceType | resourceId | normalize(title))
```

- 已有 `open|triaged` 同键 → `occurrenceCount++`，更新 `updatedAt` / evidence。
- 已 `done|dismissed` 再出现 → **复活为 open**（重置状态，保留历史计数可选）。

### D4：历史时间轴两阶段

- **P0/P1**：前端合并投影终态 + LoopRun + Session 摘要 + 审批审计条目；按时间排序；筛选 module / workspaceId / resourceId。
- **P2**：SQLite `task_events`（或等价）写入维度字段，时间轴改查索引；AI Session 为一级节点，Trace 展开加载。

### D5：入口收敛

- StatusBar `BackgroundTasksWindow`：仅运行中快捷列表 →「在任务中心打开」。
- `AiTaskAndDraftPanel`：保留实时审批 + 当前会话编排摘要；「打开面板」→ `/tasks`（**BREAKING 行为**：不再误开 StatusBar 浮窗）。
- Loop Spec 启停：任务中心待办/运行详情可链到轻量配置，完整编辑不搬迁。

### D6：Workflow 运行

- 先修 `WorkflowPanel` → `commands.workflowRun`。
- 监听 `workflow-step-update` / `workflow-execution-complete`，投影为 `passive_job`（module=`workflow`）。
- 定义 CRUD 仍在 `/workflow`。

### 架构数据流

```
  [database/knowledge/…]     [workflow_run]      [loopRunner]      [ToolGate]
           │                      │                   │                │
           ▼                      ▼                   ▼                ▼
     WorkerPool              WorkflowExec          loopStore      actionDraft
     bg-task-update          事件/SQLite           runs+findings   (内存+超时)
           │                      │                   │                │
           └──────────┬───────────┴────────┬──────────┘                │
                      ▼                    ▼                           │
              taskCenter projection ◄──────┴──── 只读状态「等待确认」◄──┘
                      │
          ┌───────────┼───────────┐
          ▼           ▼           ▼
       运行中        待办        历史时间轴
    passive+active  inbox      jobs+approval+sessions
```

### UI

- 复用现有 `ModuleWorkspaceLayout` + 左侧索引 + 右侧详情；tokens 与 `task-center-*` 样式延续。
- 三模式 IconRail：运行中 / 待办 / 历史；运行中可筛被动/主动。
- 文案走 i18n（zh-CN 默认）。

### IPC（按阶段）

| 阶段 | 命令（示例） | 说明 |
|------|----------------|------|
| P1 | `bg_task_history_list` / 终态写入 | specta + `npm run gen:bindings` |
| P1 | 现有 `workflowRun` 接通前端 | 已有 bindings |
| P2 | `task_events_list`（filter） | 新表 + OmniError |

## Risks / Trade-offs

| 风险 | 缓解 |
|------|------|
| 投影层双写/重复计数（如 SSH 舰队同时写 orchestration + bg） | 投影去重规则：同一 `backendJobId`/`parentId` 只展示一条 |
| Draft.execute 不可序列化 | 审批不进持久 Inbox；历史只记审计字段 |
| 历史空洞（旧 bg 无落库） | P1 起新终态落库；旧数据不保证 |
| Finding 复活策略不符合部分用户预期 | 设置项预留；默认复活 open |
| Workflow UI 接通后风险操作 | 沿用 workflow risk/env_tag 与执行确认策略 |

## Migration Plan

1. **P0**：仅改 `/tasks` IA + 投影只读聚合 + 入口跳转；不改存储。可回滚为旧 Tab。
2. **P1**：Finding fingerprint；bg 终态保留；Workflow run 接通并投影。
3. **P2**：`task_events` + 时间轴分组增强。
4. 回滚：特性开关或保留旧组件文件一版；IndexedDB finding 合并向前兼容（新字段默认 1）。

## Open Questions

- 历史默认保留窗口：30 天 vs 500 条 vs 无上限（建议先 **500 条或 30 天取先到者**）。
- 审批超时是否按 risk 分级（critical 更短/更长）？
- Loop Spec 管理入口：设置页 vs 任务中心次级页 vs 保留现 Loops Tab 降级为「配置」。
