## Why

`ai-harness-foundation` 已把 Plan / 子会话并行 / ToolGate / digest 收成内核；但产品入口仍偏「侧栏聊天 + 终端 inline」。PRD「AI 不是聊天窗口」与首页「AI 快捷入口」（约 §1041）要求：首页与模块现场能一键把**当前上下文**送进同一条提交管线，而不是另造一套对话。现在补表面层，才能让内核能力被日常操作碰到。

## 目标

- 首页 Dashboard 提供 **AI 主输入**（大输入框 + 发送），走既有 `submitAiPrompt` / `sendToAiDock`，可触发 plan / cluster / ToolGate。
- 首页提供 **轻量建议/提醒芯片**（来自任务中心草稿、活动任务、Finding 等已有投影），点击即填入或直发 AI。
- 在 database / docker / files / server（及已有终端能力对齐）模块工具栏增加 **「问 AI」**，自动附带模块 ContextBridge 文本，不旁路 Harness。
- 所有表面共用一套 `AskAi` 助手 API，禁止模块各自 `invoke` 聊天。

## 非目标（Non-goals）

- 不改 Harness 写入口、不重做 spawn/plan/gate。
- 不做无人值守自动执行；prod / 高风险仍走 ToolGate 与环境标签确认。
- 不做全模块铺满营销式「AI 助手页」；协议 / 工作流 / 知识库可留后续迭代。
- 不替换任务中心信息架构；建议芯片只读投影，不新建第二套任务模型。
- 不实现 Companion / 云同步。

## 背景与动机

- 现状：`HomeBoardView` 仅资源/任务概览；`sendToAiDock` 已有，但首页无入口；模块「发给 AI」零散（终端 block 菜单有，DB/Docker 等缺失）。
- 内核已就绪：`ai-harness-foundation` inventory/digest/取消/context 继承。
- Phase：影响 Phase 1 体验与首页 `/dashboard`，以及 `/database` `/docker` `/files` `/server` 工具栏；不阻塞 Database 后端深化。

## What Changes

- 新增共享 UI/API：`AskAiComposer`（可嵌首页）+ `askAiFromSurface`（统一打开 Dock、绑 agent/context、调用 `sendToAiDock`/`submitAiPrompt`）。
- Dashboard `HomeBoardView`：顶部 AI 输入区 + 建议芯片（draft / running / inbox 摘要）。
- 模块面板：database / docker / files / server 增加「问 AI」按钮（注入 `getModuleAiContextText`）。
- i18n（zh-CN / en-US）与少量首页样式。
- 轻量单测：建议芯片选择逻辑、askAiFromSurface 选项归一。

## Capabilities

### New Capabilities

- `dashboard-ai-entry`: 首页 AI 主输入与建议/提醒芯片。
- `module-ask-ai`: 模块工具栏「问 AI」与上下文注入契约。
- `ai-surface-submit`: 表面层统一提交助手（绑会话 / Dock / context，复用 Harness 管线）。

### Modified Capabilities

<!-- openspec/specs/ 暂无既有能力需改需求级行为 -->

## 成功标准

- 从 `/dashboard` 输入一句话可打开 AI Dock 并进入真实会话（可调工具 / plan）。
- 点击建议芯片能带上对应上下文或预填提示。
- 在 database/docker/files/server 点「问 AI」后，请求带有非空 `moduleContextAppend`（有模块 provider 时）。
- 无新的旁路聊天 IPC；prod 操作仍需确认。

## Impact

- 前端：`modules/workspace/HomeBoardView`、`lib/ai/surfaces/`（新）、`sendToAiDock`、各模块顶栏/工具栏、`i18n`、首页 CSS。
- 路由：`/dashboard` 与上述模块路径；不改后端命令清单。
- 依赖：`ai-harness-foundation` 已合并的提交管线与 ContextBridge。
- 环境与确认：表面层只发起建议；执行仍经 ToolGate / 环境标签。
