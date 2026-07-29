import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/ai/reportToolResult", () => ({
  reportToolResultWithRetry: vi.fn(async () => undefined),
}));

vi.mock("../../stores/aiStore", () => {
  const conversations: Array<{
    id: string;
    messages: Array<{ id: string; parts?: unknown[] }>;
  }> = [];
  return {
    useAiStore: {
      getState: () => ({
        conversations,
        upsertStreamPlan: vi.fn(),
      }),
    },
  };
});

import { useAiOrchestrationStore } from "../../stores/aiOrchestrationStore";
import { useBlocksStore } from "../../stores/blocksStore";
import {
  dispatchPlanCreate,
  dispatchPlanUpdateStep,
} from "../../lib/ai/orchestration/planToolDispatcher";
import { extractLatestPlanSnapshot, formatPlanProgressLabel, resolvePlanCompactBadge } from "./terminalAiPlan";

const BADGE_LABELS = {
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  executing: "执行中",
  planning: "规划中",
};

describe("terminal inline plan", () => {
  beforeEach(() => {
    useAiOrchestrationStore.setState({ plans: {} });
    useBlocksStore.setState({ blocks: {} });
  });

  it("formatPlanProgressLabel counts completed and skipped", () => {
    expect(
      formatPlanProgressLabel({
        id: "p1",
        title: "t",
        status: "executing",
        createdAt: 1,
        updatedAt: 1,
        steps: [
          { id: "s1", title: "a", status: "completed" },
          { id: "s2", title: "b", status: "skipped" },
          { id: "s3", title: "c", status: "pending" },
        ],
      }),
    ).toBe("2/3");
  });

  it("resolvePlanCompactBadge shows current step while running", () => {
    expect(
      resolvePlanCompactBadge(
        {
          id: "p1",
          title: "巡检",
          status: "executing",
          createdAt: 1,
          updatedAt: 1,
          steps: [
            { id: "s1", title: "概况", status: "completed" },
            { id: "s2", title: "采集内存与进程", status: "in_progress" },
            { id: "s3", title: "磁盘", status: "pending" },
          ],
        },
        BADGE_LABELS,
      ),
    ).toEqual({
      progress: "1/3",
      detail: "采集内存与进程",
      tone: "running",
    });
  });

  it("resolvePlanCompactBadge shows completed label when done", () => {
    expect(
      resolvePlanCompactBadge(
        {
          id: "p1",
          title: "巡检",
          status: "completed",
          createdAt: 1,
          updatedAt: 1,
          steps: [
            { id: "s1", title: "概况", status: "completed" },
            { id: "s2", title: "内存", status: "completed" },
          ],
        },
        BADGE_LABELS,
      ),
    ).toEqual({
      progress: "2/2",
      detail: "已完成",
      tone: "completed",
    });
  });

  it("dispatchPlanCreate writes plan into blocksStore aiThread parts", async () => {
    const blockId = "blk-plan-1";
    const sessionId = "sess-plan-1";
    const msgId = "asst-1";
    const toolCallId = "tc-plan-1";

    useBlocksStore.setState({
      blocks: {
        [sessionId]: [
          {
            id: blockId,
            sessionId,
            kind: "ai",
            title: "check host",
            command: "# check host",
            output: "",
            aiThread: [
              {
                kind: "message",
                id: "user-1",
                role: "user",
                content: "check host",
                timestamp: 1,
              },
              {
                kind: "message",
                id: msgId,
                role: "assistant",
                content: "",
                timestamp: 2,
                parts: [
                  {
                    type: "tool-call",
                    id: toolCallId,
                    name: "omni_plan_create",
                    arguments: "{}",
                    status: "running",
                  },
                ],
              },
            ],
            exitCode: null,
            startLine: -1,
            endLine: -1,
            marker: null,
            cwd: "/",
            timestamp: 1,
            status: "running",
          },
        ],
      },
    });

    await dispatchPlanCreate({
      conversationId: `term-inline:${sessionId}`,
      toolCallId,
      argsJson: JSON.stringify({
        title: "巡检",
        steps: [{ title: "查磁盘" }, { title: "查内存" }],
      }),
      inline: { blockId, sessionId },
    });

    const block = useBlocksStore.getState().findBlockById(blockId);
    const plan = extractLatestPlanSnapshot(block);
    expect(plan?.title).toBe("巡检");
    expect(plan?.steps).toHaveLength(2);
    expect(useAiOrchestrationStore.getState().plans[plan!.id]).toBeTruthy();

    await dispatchPlanUpdateStep({
      conversationId: `term-inline:${sessionId}`,
      toolCallId: "tc-upd-1",
      argsJson: JSON.stringify({
        plan_id: plan!.id,
        step_id: plan!.steps[0]!.id,
        status: "completed",
      }),
      inline: { blockId, sessionId },
    });

    const updated = extractLatestPlanSnapshot(
      useBlocksStore.getState().findBlockById(blockId),
    );
    expect(updated?.steps[0]?.status).toBe("completed");
    expect(formatPlanProgressLabel(updated!)).toBe("1/2");
  });
});
