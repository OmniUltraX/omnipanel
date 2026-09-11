## Why

OmniPanel 已具备 Plan todolist、子会话并行集群、ToolGate、Skill、ai_traces 与任务中心投影，但彼此割裂、状态多源，开发者与用户难以回答「这次失败在 prompt / tool / skill / gate / 哪条子会话」。前沿 Harness Engineering 强调组件/经验/决策三可观测；现在补上「清单 + 蒸馏 + 有机编排契约」，才能在不另起炉灶的前提下把 AI 内核打牢。影响 Phase 1–4 全局 AI 能力（侧栏 / 终端 inline / 任务中心），不改变各模块 prod 确认策略。

## 目标

- 建立 **Harness 组件可观测清单**（含 active plan / cluster / gate / agent / prompt / tools / skills）。
- 建立 **父子/并行感知的经验 digest**，接通 Trace 复盘与 Skill 提取。
- 明确 **Plan + 子会话并行 + ToolGate** 一体编排契约与唯一写入口，收口乱写。
- 补齐模块 Agent 默认 prompt；Loop 真接通一条或降级为实验，避免假能力。

## 非目标（Non-goals）

- 不做无人值守自动改 harness（Evolve Agent / 自动改 tool 实现）。
- 不做首页 Dashboard 大输入框与全模块「问 AI」表面铺开（后续 `ai-first-surfaces`）。
- 不重写 spawn/plan 运行时；不抢 `global-task-center` 投影模型。
- 不削弱 ToolGate / 环境标签 / 审计基线；并行子会话不得成为逃逸通道。

## 背景与动机

工具真相源已由 `unify-ai-tool-registry` 夯实；编排能力（plan / sub-conv / gate / loop）可用但叙事分裂。PRD「AI 不是聊天窗口」要求操作链可审计、可复盘；任务中心已能投影 AI 编排，却缺 digest 与 harness 地图。

## What Changes

- 新增前端 `lib/ai/harness`：inventory、digest、编排写入口约定与文档化边界。
- 设置「智能体」或调试区增加 Harness 清单只读视图。
- 任务中心 AI Trace / SkillEvolution 接入 digest（含 plan + cluster 摘要）。
- 补齐 database/docker/files 等 Agent 默认 prompt（多步 plan / 并行 spawn 指引）。
- Loop：标记实验或接通一条 Skill 路径（实现时二选一，默认降级实验文案）。
- ContextBridge 契约与子会话继承规则文档 + 轻量对齐。
- 回归测试：inventory/digest、plan+cluster 摘要字段。

## Capabilities

### New Capabilities

- `ai-harness-model`: Harness 组件清单与元数据（含 plan/cluster/gate）。
- `ai-orchestration-coherence`: Plan + 子会话并行 + Gate 一体编排契约与写入口。
- `ai-experience-corpus`: 父子/并行感知的证据蒸馏 digest。
- `ai-harness-feedback`: 以整次编排为单位的 Skill/outcome 引导回写。
- `ai-runtime-coherence`: 提交管线、ContextBridge、Loop、侧栏/inline 对齐。

### Modified Capabilities

<!-- openspec/specs/ 无既有能力需改需求级行为 -->

## 成功标准

- 开发者能在 10 分钟内回答「失败在哪一层 / 哪个子会话 / plan 哪一步」。
- inventory 能列出当前会话 active plan 与 clusters。
- digest 可一键带入 Skill 提取；并行场景复盘路径可讲清。
- 旁路写 plan/cluster 的入口被文档与代码注释收口。

## Impact

- 前端：`lib/ai/harness/*`、`aiOrchestrationStore` 消费者、`SkillEvolutionPrompt`、`LoopTriagePanels`、`AgentConfigSection`、modules/*/ai ContextBridge、`loopRunner`、agents prompts。
- 后端：`agent_prompt` 种子扩展；可选只读 digest 辅助（优先前端组合 traces + orchestration）。
- 路由：`/settings`（agent）、`/tasks`（Trace）；不改模块路由主流程。
- 环境与确认：沿用既有 ToolGate；digest 只读不触发执行。
