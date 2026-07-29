import { beforeEach, describe, expect, it, vi } from "vitest";

const aiChatCancel = vi.fn().mockResolvedValue(undefined);
const setClusterStatus = vi.fn();
const updateClusterChild = vi.fn();
const setStreamClusterStatus = vi.fn();

const orchState = {
  clusters: {} as Record<
    string,
    {
      clusterId: string;
      parentConversationId: string;
      parentMessageId: string;
      status: string;
      children: Array<{ conversationId: string; status: string }>;
    }
  >,
};

vi.mock("../../../ipc/bindings", () => ({
  commands: {
    aiChatCancel: (...args: unknown[]) => aiChatCancel(...args),
  },
}));

vi.mock("../../../stores/aiOrchestrationStore", () => ({
  useAiOrchestrationStore: {
    getState: () => ({
      clusters: orchState.clusters,
      setClusterStatus: (...args: unknown[]) => setClusterStatus(...args),
      updateClusterChild: (...args: unknown[]) => updateClusterChild(...args),
    }),
  },
}));

vi.mock("../../../stores/aiStore", () => ({
  useAiStore: {
    getState: () => ({
      setStreamClusterStatus: (...args: unknown[]) => setStreamClusterStatus(...args),
      updateStreamClusterChild: vi.fn(),
    }),
  },
}));

import {
  cancelAllRunningClusters,
  cancelCluster,
  cancelConversationClusters,
  getClusterAbortController,
} from "./clusterCancellation";

describe("clusterCancellation", () => {
  beforeEach(() => {
    orchState.clusters = {};
    aiChatCancel.mockClear();
    setClusterStatus.mockClear();
    updateClusterChild.mockClear();
    setStreamClusterStatus.mockClear();
  });

  it("cancelCluster 取消剩余子会话并通知后端", () => {
    orchState.clusters["c1"] = {
      clusterId: "c1",
      parentConversationId: "parent",
      parentMessageId: "msg",
      status: "running",
      children: [
        { conversationId: "child-a", status: "running" },
        { conversationId: "child-b", status: "completed" },
        { conversationId: "child-c", status: "pending" },
      ],
    };
    getClusterAbortController("c1");

    cancelCluster("c1");

    expect(setClusterStatus).toHaveBeenCalledWith("c1", "cancelled");
    expect(aiChatCancel).toHaveBeenCalledWith("child-a");
    expect(aiChatCancel).toHaveBeenCalledWith("child-c");
    expect(aiChatCancel).not.toHaveBeenCalledWith("child-b");
    expect(updateClusterChild).toHaveBeenCalledWith(
      "c1",
      "child-a",
      expect.objectContaining({ status: "cancelled" }),
    );
    expect(setStreamClusterStatus).toHaveBeenCalledWith(
      "parent",
      "msg",
      "c1",
      "cancelled",
    );
  });

  it("cancelConversationClusters 只取消该父会话下的集群", () => {
    orchState.clusters["c1"] = {
      clusterId: "c1",
      parentConversationId: "parent-a",
      parentMessageId: "m1",
      status: "running",
      children: [{ conversationId: "x", status: "running" }],
    };
    orchState.clusters["c2"] = {
      clusterId: "c2",
      parentConversationId: "parent-b",
      parentMessageId: "m2",
      status: "running",
      children: [{ conversationId: "y", status: "running" }],
    };

    cancelConversationClusters("parent-a");

    expect(setClusterStatus).toHaveBeenCalledWith("c1", "cancelled");
    expect(setClusterStatus).not.toHaveBeenCalledWith("c2", "cancelled");
  });

  it("cancelAllRunningClusters 批量取消 running/pending", () => {
    orchState.clusters["c1"] = {
      clusterId: "c1",
      parentConversationId: "p",
      parentMessageId: "m",
      status: "running",
      children: [{ conversationId: "a", status: "running" }],
    };
    orchState.clusters["c2"] = {
      clusterId: "c2",
      parentConversationId: "p",
      parentMessageId: "m",
      status: "pending",
      children: [{ conversationId: "b", status: "pending" }],
    };
    orchState.clusters["c3"] = {
      clusterId: "c3",
      parentConversationId: "p",
      parentMessageId: "m",
      status: "completed",
      children: [{ conversationId: "c", status: "completed" }],
    };

    const n = cancelAllRunningClusters();
    expect(n).toBe(2);
    expect(setClusterStatus).toHaveBeenCalledWith("c1", "cancelled");
    expect(setClusterStatus).toHaveBeenCalledWith("c2", "cancelled");
    expect(setClusterStatus).not.toHaveBeenCalledWith("c3", "cancelled");
  });
});
