## Why

终端 NL 问「当前的时间」时，同一套「必须 omni_terminal_exec / 禁止编造 / 不要 resource_id」被叠进 user 改写、Terminal Context、Agent md、ACP preamble、HTTP 路由短句和工具 description。模型把改写后的 user 当成「用户明确要求」。Skills 摘要承诺 `load_skill`，但该工具不是 cross-module，终端 Agent 工具面没有它。现在要把注入链路收成「一层只说一件事」，并让 Skills/MCP 只描述本轮真正可用的工具。

## What Changes

- 抽出共享 `routing-policy.md`，ACP preamble 与 HTTP system 共用，删除平行长句。
- 删除 user 消息末尾强制 exec 军令；收短 Terminal Context IMPORTANT；HTTP 去掉本机时间与重复 cwd。
- 瘦身 Agent 角色 md；补齐 server/knowledge 等缺文件的默认 md；`agent_id` 变化时 ACP 重注角色。
- `load_skill`（及 `omni_skill_recall`）纳入 cross-module；Skills 摘要按工具面裁剪，勾选 Skill 不在目录里重复。
- 工具 spec 描述 MUST 靠前（ACP 140 字）；前端 handler 描述不再当第二真相。
- ACP native Read/Write 按本轮是否有 `omni_files_*` 与 shell 类型映射；无 `resource_id` 的 `omni_ssh_exec` 不再被文案鼓励走 PTY。

## 目标

- 用户消息只含原话（可加 blockContext），不再追加「必须调用…」。
- HTTP/ACP 路由句来自同一文件；远程 Tab 不再注入本机 `Current local date-time`。
- 终端 Agent 能调用 `load_skill`；Skills 文案与工具列表一致。
- 模块 Agent 不暗示未注入的外部 MCP。

## 非目标（Non-goals）

- 不覆盖用户深度自定义的 `~/.omnipd/prompts`。
- 不把外部 MCP 灌进所有模块 Agent。
- 不重写 ToolGate / 确认闸。
- 不新增长篇 README。

## 背景与动机

`unify-ai-tool-registry` 已把 schema 收到 Rust；`ai-harness-foundation` 已补 inventory。缺的是 **灌进模型的文本仍多源复读，且与工具面不一致**。影响 Phase 1 全局 AI（侧栏 / 终端 inline，`/settings` 智能体、`/terminal`）。

## 成功标准

- 终端问时间：user 只有原话。
- HTTP 远程 Tab system 无本机日期行。
- 勾选 Skill 只出现在 Active Skills。
- `tsc -b` 与相关 rust/vitest 全绿。

## Capabilities

### New Capabilities

- `ai-prompt-layers`: 提示词分层与去重复注入（routing / 角色 / 现场 / 用户原话）
- `ai-skills-tool-coherence`: Skills 摘要与本轮工具面一致；load_skill 跨模块
- `ai-native-tool-routing`: ACP 原生工具与 omni_files / shell 对齐

### Modified Capabilities

- （无既有 `openspec/specs/` capability）

## Impact

- 前端：`warpExperience.ts`、`buildTerminalAiContext.ts`、`composerContextAppend.ts`、`AiRuntimeProvider.tsx`、`registry.ts`、`internalToolBridge.ts`、`moduleBuiltinCatalog.ts`、`HarnessInventoryPanel`、各 `mcpTools.ts` 描述
- 后端：`prompts.rs`、`internal.rs`、`agent_prompt.rs`、`system-prompt.md`、`agents/*.md`、`skill.rs`、`builtin_tool_spec.rs`、`ai_chat.rs`、`native_tools.rs`、`omnipanel-server/src/ai.rs`
- 环境与确认：不改 ToolGate；只改模型看到的文本与工具映射
