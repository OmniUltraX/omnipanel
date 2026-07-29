# AI Harness（内核）

OmniPanel 的 AI 差异化在 **Harness**（模型之外的 prompt / tools / skills / plan / 子会话并行 / ToolGate / memory），不是侧栏聊天框本身。

## 编排地图

```
Composer / Terminal inline
  → submitAiPrompt / AiRuntimeProvider
    → ai_chat (HTTP | ACP)
    → pending tools → internalToolBridge
         ├─ planToolDispatcher      → plans
         ├─ subConversationRunner   → clusters（并行子会话）
         │    └─ childRequestContext  继承父 workspace/terminal/module append
         ├─ toolGate                → actionDraftStore
         └─ module handlers
  → ai_traces / 任务中心投影 / SkillEvolution
```

取消传播：`cancelCluster` / `cancelConversationClusters`（侧栏停流、终端停卡、任务中心取消全部）。

## 写入口白名单

见 `writeEntries.ts`。禁止业务代码旁路 `createPlan` / `createCluster`（测试除外）。

## 验收问句

1. 这次失败是 prompt / tool / skill / gate 哪一层？
2. 若有并行：哪个子会话失败？对应 plan 哪一步？能否在卡片上「取消剩余」？
3. 有没有基于整次编排（父+plan+cluster）回写 Skill？
4. 子会话是否继承了父会话终端 / 模块现场（非空 append）？

## 后续

- OpenSpec：`openspec/changes/ai-harness-foundation`
- 表面层：`openspec/changes/ai-first-surfaces`（Dashboard 输入 + 模块「问 AI」，复用本管线）
