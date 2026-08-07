## Why

终端直通（Shell Agent）模式下，`omni_ask_user` 与 `omni_plan_*` 的 dispatcher / 数据层已就绪，但流内 overlay 未渲染：模型已发起澄清或更新计划时，用户在 xterm 旁看不到表单与进度。现在补齐直通可见性，避免「工具已调、界面无反馈」。

## What Changes

- 直通 overlay 增加 **询问表单流内卡片**（`omni_ask_user`）：挂起续跑，提交/跳过回传后继续；提交后冻成可回看摘要。
- 直通 pane 增加 **Plan 吸底 live strip**（`omni_plan_*`）：固定在终端视口底部，进度原地刷新；不随 buffer 卷走。
- Plan **创建 / 终态**可选写入一张流内冻结卡；**默认不**在每步 `update_step` 时再盖新卡。
- 扩展 Shell Agent 阶段/几何以支持 `awaiting_user_input` 与 plan 并存，不破坏现有思考→审批→结果环。

## 目标

- 直通模式下用户能完成 Ask 表单交互，且选项/文字答案可回看。
- 长输出滚动时 Plan 当前进度始终可见（吸底条）。
- 复用现有 `askUserToolDispatcher` / `planToolDispatcher` / `UserQuestionForm` / `PlanView`，不新造数据协议。

## 非目标（Non-goals）

- 不接入任务中心 `omni_knowledge_save_todolist`（与 `omni_plan_*` 分离）。
- 不恢复已废弃的思考卡 sticky 兜底；吸底仅用于 Plan live 状态。
- 不改造 Command Bar / Warp Block Feed 既有 Plan 徽章（可并存）。
- 不引入新的后端工具名或 breaking IPC。

## 背景与动机

Phase 1 终端 + AI 直通环已具备命令审批流内卡（方案 C decoration）。Ask/Plan 走 hidden chat tools，侧栏与 Block Feed 有 UI，直通 `interactive` 路径却空白。用户明确认可方案：**Ask = 流内卡；Plan = 吸底 live + 起止冻结卡**。

## 成功标准

- 直通会话调用 `omni_ask_user` 时，光标附近出现可交互表单卡；提交后模型收到答案并续跑；scrollback 可点开摘要。
- 调用 `omni_plan_create` 后 pane 底部出现进度条；`update_step` 只刷新条内文案/进度，不堆卡；大量 PTY 输出后条仍可见。
- 计划完成/失败时有终态呈现（条上终态 + 可选冻结卡）；点击条可打开完整 `PlanView`。
- `tsc -b` 通过；既有 Shell Agent 审批/思考/结果路径回归不挂。

## Capabilities

### New Capabilities

- `passthrough-ask-card`: 直通模式下 `omni_ask_user` 的流内询问卡与冻结摘要
- `passthrough-plan-strip`: 直通模式下 `omni_plan_*` 的吸底 live 进度条与起止冻结卡

### Modified Capabilities

- （无既有 openspec capability 需改 requirement；本变更为终端直通增量）

## Impact

- **模块 / 路由**：Terminal（`/terminal`）、SSH 直通会话；Phase 1 AI 直通环
- **前端**：`shellAgent/*`、`ShellAgentOverlay`、`inlineToolBridge` 通知、可能新增 pane 级 strip 组件；复用 `UserQuestionForm` / `PlanView` / orchestration dispatchers
- **数据**：继续用 `blocksStore` parts（`user-question` / `plan`）与 `aiOrchestrationStore.plans`
- **环境**：无生产数据修改；Ask/审批仍需用户显式确认
