/**
 * Harness 编排写入口白名单（生产路径）。
 *
 * 旁路直接调用 `aiOrchestrationStore.createPlan/createCluster` 仅允许测试；
 * UI/业务 MUST 经下列入口，以保持 Plan + 子会话 + Gate 一体叙事。
 *
 * 编排地图见同目录 README.md 与 openspec/changes/ai-harness-foundation/design.md。
 */
export const HARNESS_WRITE_ENTRIES = [
  {
    id: "internalToolBridge",
    path: "frontend/src/lib/ai/internalToolBridge.ts",
    role: "UiDelegated 工具总分派（含 plan / spawn / 模块工具）",
  },
  {
    id: "planToolDispatcher",
    path: "frontend/src/lib/ai/orchestration/planToolDispatcher.ts",
    role: "omni_plan_* → plans + message/block parts",
  },
  {
    id: "subConversationRunner",
    path: "frontend/src/lib/ai/orchestration/subConversationRunner.ts",
    role: "omni_spawn_* / 舰队派发 → clusters + 子会话",
  },
  {
    id: "clusterCancellation",
    path: "frontend/src/lib/ai/orchestration/clusterCancellation.ts",
    role: "取消集群 / 子会话",
  },
  {
    id: "toolGate",
    path: "frontend/src/lib/ai/toolGate.ts",
    role: "危险工具确认闸 → actionDraftStore",
  },
] as const;

export type HarnessWriteEntryId = (typeof HARNESS_WRITE_ENTRIES)[number]["id"];
