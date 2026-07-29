## Context

Harness 内核（`ai-harness-foundation`）已就绪：`submitAiPrompt` / `sendToAiDock`、ContextBridge、plan/cluster、ToolGate。首页 `HomeBoardView` 仍是资源/任务看板，无 AI 入口；database/docker/files/server 有 ContextBridge 但缺「问 AI」按钮。本 change 只做**表面层**，前后端边界：全部前端；无新 IPC。

## Goals / Non-Goals

**Goals:**

- 首页 AI 主输入 + 建议芯片，复用提交管线。
- 模块侧栏顶栏「问 AI」，注入模块 context 与对应 Agent。
- 统一 `askAiFromSurface`，禁止旁路。

**Non-Goals:**

- 不改 Harness 写入口 / 任务中心 IA。
- 不做 protocol/workflow/knowledge 首批铺开。
- 不自动执行；不新增后端命令。

## Decisions

### 1. 共享包 `frontend/src/lib/ai/surfaces/`

- `askAiFromSurface(options)`：打开 Dock、可选 `newConversation`、`setConversationAgentId(agentIdForModule)`、拼默认 prompt、调用 `sendToAiDock`（模块 context 已由 AiRuntimeProvider 经 focusModule 注入；另可显式 `contextChips`）。
- `buildDashboardSuggestionChips(...)`：纯函数，从 drafts / running tasks / inbox findings 生成芯片（上限 5）。
- `AskAiComposer`（`components/ai/AskAiComposer.tsx`）：受控/非受控输入 + 发送。

**备选**：各模块直接 `sendToAiDock` —— 拒绝，易漏绑 Agent / 打开抽屉。

### 2. 首页嵌入位置

`HomeBoardView` 顶部、`dash-grid` 之上：`AskAiComposer` + 建议芯片行。发送走 `askAiFromSurface({ surface: "dashboard", prompt })`（Agent=`run`，新会话可选）。

### 3. 模块「问 AI」挂点

扩展 `ModuleWorkspaceLayout` / `ModuleLeftColumn`：`leftHeaderActions?: ReactNode`，放入 header `__actions`（在 `iconRail` 前）。  
database / docker / files / server 传入 `<ModuleAskAiButton moduleKey=... />`。  
点击：`askAiFromSurface({ surface: "module", moduleKey, prompt: 默认「请基于当前模块上下文…」或弹轻量输入 })`。

**默认交互**：按钮点击打开 Dock 并预填一句模块引导 prompt（可立即发送）；长提示留给 Dock Composer 继续。避免在侧栏再塞大输入框。

### 4. Context 注入策略

- 模块页：依赖已挂载的 `*ModuleContextBridge` + Runtime 的 `getModuleAiContextText(focusModule)`；`askAiFromSurface` 同时 `setConversationAgentId`。
- 首页：无模块 focus 时用 `run` Agent；芯片可带 `contextChips`（任务/草稿标题）。

### 5. 建议芯片数据源

只读：`useDashboardData` 的 drafts/activeTasks + 可选 `useTaskCenterProjection` inbox 前几条。不写 store。

## Risks / Trade-offs

- [Risk] 首页建议噪声 → 上限 5、空态隐藏整行。
- [Risk] 模块按钮默认 prompt 过泛 → i18n 分模块短引导；用户可在 Dock 改。
- [Risk] focusModule 与路由不同步 → 发送前 `navigate` 不强制；依赖用户已在模块页。
- [Risk] 布局挤 → `leftHeaderActions` 用紧凑 icon 按钮。

## Migration Plan

纯增量 UI；可整段 revert。无数据迁移、无 bindings。

## Open Questions

- 首页发送默认「当前会话」还是「新会话」？→ **默认新会话**（驾驶舱意图更清晰），composer 旁可选「继续当前」（P1 可后续）。
