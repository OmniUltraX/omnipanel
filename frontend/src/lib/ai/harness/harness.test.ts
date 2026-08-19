import { beforeEach, describe, expect, it, vi } from "vitest";

const orchState = {
  plans: {} as Record<string, unknown>,
  clusters: {} as Record<string, unknown>,
  tasks: {} as Record<string, unknown>,
};

vi.mock("../../../stores/aiModelsStore", () => ({
  useAiModelsStore: {
    getState: () => ({ providers: [] }),
    setState: vi.fn(),
  },
}));

vi.mock("../../../stores/aiStore", () => ({
  useAiStore: {
    getState: () => ({
      conversations: [
        {
          id: "conv-parent",
          title: "t",
          messages: [],
          provider: "openai",
          model: "gpt",
          createdAt: 1,
          updatedAt: 1,
          agentId: "run",
          selectedSkillIds: ["ops-ssh"],
        },
      ],
      activeConversationId: "conv-parent",
      currentSkillIds: [],
    }),
    setState: vi.fn(),
  },
}));

vi.mock("../../../stores/aiOrchestrationStore", () => ({
  useAiOrchestrationStore: {
    getState: () => ({
      ...orchState,
      createPlan: (plan: unknown) => {
        const p = plan as { id: string };
        orchState.plans[p.id] = plan;
      },
      createCluster: (cluster: unknown) => {
        const c = cluster as { clusterId: string };
        orchState.clusters[c.clusterId] = cluster;
      },
    }),
    setState: (partial: Partial<typeof orchState>) => {
      Object.assign(orchState, partial);
    },
  },
}));

import { buildExperienceDigest } from "./digest";
import { buildHarnessInventory } from "./inventory";
import { HARNESS_WRITE_ENTRIES } from "./writeEntries";
import { useAiOrchestrationStore } from "../../../stores/aiOrchestrationStore";

describe("ai harness", () => {
  beforeEach(() => {
    orchState.plans = {};
    orchState.clusters = {};
    orchState.tasks = {};
  });

  it("lists write entries", () => {
    expect(HARNESS_WRITE_ENTRIES.map((e) => e.id)).toContain("planToolDispatcher");
    expect(HARNESS_WRITE_ENTRIES.map((e) => e.id)).toContain("subConversationRunner");
  });

  it("inventory includes active plan and cluster", () => {
    useAiOrchestrationStore.getState().createPlan({
      id: "plan-1",
      title: "巡检",
      status: "executing",
      createdAt: 1,
      updatedAt: 2,
      steps: [
        { id: "s1", title: "a", status: "completed" },
        { id: "s2", title: "b", status: "in_progress" },
      ],
    });
    useAiOrchestrationStore.getState().createCluster({
      clusterId: "cl-1",
      title: "并行体检",
      toolCallId: "tc",
      parentConversationId: "conv-parent",
      parentMessageId: "m1",
      status: "running",
      children: [
        {
          conversationId: "child-1",
          index: 0,
          title: "host-a",
          status: "running",
          spawnSpec: { title: "host-a", task: "check" },
        },
      ],
      createdAt: 1,
    });

    const inv = buildHarnessInventory("conv-parent");
    expect(inv.agentId).toBe("run");
    expect(inv.activePlans[0]?.planId).toBe("plan-1");
    expect(inv.activePlans[0]?.doneSteps).toBe(1);
    expect(inv.activeClusters[0]?.clusterId).toBe("cl-1");
    expect(inv.skillIds).toContain("ops-ssh");
    expect(inv.toolFamilySummary).toContain("extmcp");
    expect(inv.toolFamilySummary).toContain("load_skill");
  });

  it("inventory empty orchestration", () => {
    const inv = buildHarnessInventory("conv-parent");
    expect(inv.activePlans).toEqual([]);
    expect(inv.activeClusters).toEqual([]);
  });

  it("digest covers plan and clusters", () => {
    useAiOrchestrationStore.getState().createPlan({
      id: "plan-1",
      title: "巡检",
      status: "completed",
      createdAt: 1,
      updatedAt: 2,
      steps: [
        { id: "s1", title: "概况", status: "completed" },
        { id: "s2", title: "磁盘", status: "completed" },
      ],
    });
    useAiOrchestrationStore.getState().createCluster({
      clusterId: "cl-1",
      title: "并行",
      toolCallId: "tc",
      parentConversationId: "conv-parent",
      parentMessageId: "m1",
      status: "completed",
      children: [
        {
          conversationId: "c1",
          index: 0,
          title: "A",
          status: "completed",
          spawnSpec: { title: "A", task: "t" },
        },
        {
          conversationId: "c2",
          index: 1,
          title: "B",
          status: "failed",
          spawnSpec: { title: "B", task: "t" },
        },
      ],
      createdAt: 1,
      finishedAt: 3,
    });

    const digest = buildExperienceDigest({
      conversationId: "conv-parent",
      traces: [{ event_type: "tool_result", payload: "Error: denied" }],
    });
    expect(digest.planSummary?.doneSteps).toBe(2);
    expect(digest.clusterSummaries).toHaveLength(1);
    expect(digest.clusterSummaries[0]?.children).toHaveLength(2);
    expect(digest.traceErrorHints.length).toBeGreaterThan(0);
    expect(digest.extractText).toContain("Plan:");
    expect(digest.extractText).toContain("B [failed]");
  });
});
