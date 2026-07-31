## Why

AI 澄清需求时只能在气泡里用自然语言追问，用户只能回打一段话；选项多、约束多时效率差且易答偏。需要像 Cursor `AskUserQuestion` 一样，把关键问题整理成可点选/可填写的结构化表单，答案再结构化回传继续推理。

## 目标

- 提供全局内置工具 `omni_ask_user`：AI 可发起一组澄清题（单选 / 多选 / 填空）。
- 对话流渲染可交互表单卡片；用户提交或跳过后，答案经 `ai_chat_tool_result` 回传，会话继续。
- 工具对任意模块 Agent 可见（与 `omni_plan_*` 同属跨模块能力）；不走审批语义。
- Agent 提示词引导：信息不清时优先调用本工具，而非纯文本连问。

## 非目标（Non-goals）

- 不替代 ToolGate / ACP permission / ActionDraft 的危险操作确认。
- 不做问卷持久化、评分、考试、多页向导、条件跳题。
- 不改 FormFillSimpleAI（那是 AI 填业务表单，方向相反）。
- 不做 Companion / 云端同步；不引入新的旁路聊天 IPC。

## 背景与动机

- 现状：`plan`/`run` 等提示词要求「先澄清 1～3 个问题」，但只有文本通道；`AiMessagePart` 无 question/form 类型；审批条多按钮仅服务执行确认。
- 可复用：`UiDelegated` + `dispatchPendingTool`（同 `omni_plan_*`）、消息 parts 持久化、侧栏 thread 自定义 part 渲染。
- Phase：强化 Phase 1 AI 体验（侧栏 `/` AI Dock 与各模块 Agent）；不阻塞 Database 后端深化。

## What Changes

- 新增 builtin 工具 `omni_ask_user`（`ToolExecKind::UiDelegated`，`module_key=web`，跨模块可见）。
- 新增消息 part 类型 `user-question`（题目、状态、答案快照）。
- 前端：`askUserToolDispatcher` 拦截挂起工具 → 写入 part → 等用户提交 → `aiChatToolResult`。
- UI：`UserQuestionForm` 卡片（单选 / 多选 / 文本输入 + 提交 / 跳过）。
- 提示词与 catalog 描述：澄清场景优先用本工具。
- i18n（zh-CN / en-US）与轻量单测（入参校验、答案序列化）。

## Capabilities

### New Capabilities

- `ai-ask-user`: AI 结构化澄清提问（工具契约、消息 part、交互表单、答案回传）。

### Modified Capabilities

<!-- openspec/specs/ 暂无既有能力需改需求级行为 -->

## 成功标准

- AI 调用 `omni_ask_user` 后，侧栏出现可交互表单；提交后会话自动继续且 tool result 含结构化答案。
- 支持至少：单选、多选、填空；可跳过（回传 skipped）。
- 与审批 / permission 路径隔离：澄清不触发 ToolGate。
- prod / 高风险执行仍走既有确认策略，本能力不削弱。

## Impact

- 后端/crate：`crates/omnipanel-store`（`builtin_tool_spec`）、可选 `omnipanel-mcp` 可见性断言、agent prompts。
- 前端：`aiMessageParts`、`internalToolBridge`、`askUserToolDispatcher`（新）、`UserQuestionForm`（新）、`assistant-ui/thread` 渲染、`moduleBuiltinCatalog`、`i18n`、AI 相关 CSS。
- 路由：AI Dock / 侧栏会话；不新增业务路由。
- 环境与确认：本能力只收集意图，不执行运维操作。
