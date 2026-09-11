## Context

编排运行时已分散在：

- 提交：`submitAiPrompt` / `AiRuntimeProvider` / 终端 inline
- 工具分派：`internalToolBridge` → `planToolDispatcher` / `subConversationRunner` / 模块 handler
- 状态：`aiStore`（消息）、`aiOrchestrationStore`（plans+clusters）、`actionDraftStore`（闸）、loop store
- 观测：`ai_traces`、任务中心 projection、SkillEvolutionPrompt

约束：crate 分层、IPC specta、不削弱安全闸、不另造 spawn/plan。

## Goals / Non-Goals

**Goals**

- 一张编排地图 + 唯一写入口清单。
- 前端可计算的 harness inventory（含 active plan/cluster）。
- 会话级 digest（plan + cluster + 工具失败线索），供 Trace / Skill 提取。
- 模块 Agent prompt 补齐；Loop 实验降级；ContextBridge 契约说明。

**Non-Goals**

- 自动 Evolve、首页 AI 表面、重写任务中心信息架构。

## Decisions

### 1. Inventory 前端纯算

`buildHarnessInventory(conversationId)` 读 `aiOrchestrationStore` + agent registry + 可选 conversation 元数据。无需新 IPC。挂设置 Agent 页「Harness」只读面板。

### 2. Digest 前端组合 + traces IPC

`buildExperienceDigest({ conversationId, traces?, orchestration })`：traces 来自 `aiListSessionTraces`；plan/cluster 来自 orchestration。不强制新表；可后续落 `ai_experience_digest`。

### 3. 写入口白名单

仅允许：

- `internalToolBridge.dispatchPendingTool`（及 plan/sub-conv 分派）
- `planToolDispatcher` / `subConversationRunner` / `clusterCancellation`
- `toolGate` / actionDraft 确认路径

其它模块禁止直接 `createPlan`/`createCluster`（测试除外）。清单写在 `harness/writeEntries.ts`。

### 4. Loop 降级为实验

`loopRunner` 在无 `pilotId` 时明确实验文案；UI 若暴露 Loop 入口加「实验」标记，避免假装已接通 Skill discover。

### 5. Prompt 种子扩展

`AGENT_PROMPT_IDS` 增加 database/docker/files（及既有 id）；默认 md 含 plan/spawn 指引。用户已有文件不覆盖（`write_if_missing`）。

### 6. Skill 回写以编排为单位

`SkillEvolutionPrompt` / extract 支持附带 digest 文本（父会话 + cluster 摘要 + plan 终态），不只抽单条子会话。

## 编排地图（写入口）

```
Composer / TerminalInline
  → submitAiPrompt / AiRuntimeProvider
  → ai_chat (HTTP|ACP)
  → pending tools → internalToolBridge
       ├─ planToolDispatcher → aiOrchestrationStore.plans (+ blocks/aiStore parts)
       ├─ subConversationRunner → clusters + child conversations
       ├─ toolGate → actionDraftStore
       └─ module handlers (terminal/db/…)
  → ai_traces / task projection / SkillEvolution signals
```

## Risks / Trade-offs

- Digest 依赖前端 orchestration 内存：刷新后仅 traces 仍在；可接受为 v1，后续可持久化 cluster 快照。
- Prompt 升级不覆盖用户自定义：模块 agent 若已有短摘要文件需 legacy 升级策略（与 terminal 类似启发式）。

## Migration

无破坏性 API；新增只读面板与种子文件。
