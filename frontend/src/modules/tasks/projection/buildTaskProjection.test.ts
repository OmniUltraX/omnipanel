import { describe, expect, it } from "vitest";
import { buildTaskProjection } from "./buildTaskProjection";
import { findingFingerprint } from "../../../lib/ai/loopPilots";
import { useLoopStore } from "../../../stores/loopStore";

describe("buildTaskProjection", () => {
  const empty = {
    bgHistory: {},
    workflowExecs: {},
  };

  it("不把审批源写入 inbox，仅投影 Finding", () => {
    const result = buildTaskProjection({
      ...empty,
      bgTasks: {},
      aiTasks: {},
      loopRuns: {},
      findings: {
        f1: {
          id: "f1",
          loopId: "loop-db-health",
          runId: "r1",
          title: "慢查询",
          summary: "发现慢查询",
          severity: "warning",
          status: "open",
          createdAt: 1,
          updatedAt: 1,
        },
      },
    });
    expect(result.inbox).toHaveLength(1);
    expect(result.inbox[0].facet).toBe("inbox");
    expect(result.inbox.every((i) => i.facet !== "approval")).toBe(true);
  });

  it("跳过 aiOrchestration 镜像 bg 任务避免双计", () => {
    const result = buildTaskProjection({
      ...empty,
      bgTasks: {
        b1: {
          id: "b1",
          module: "ai",
          kind: "aiOrchestration",
          title: "舰队体检",
          progress: "",
          status: "running",
          index: 0,
          total: 1,
          startedAt: 10,
        },
      },
      aiTasks: {
        a1: {
          id: "a1",
          conversationId: null,
          title: "舰队体检",
          kind: "sshFleetHealth",
          status: "running",
          children: [],
          startedAt: 10,
        },
      },
      loopRuns: {},
      findings: {},
    });
    expect(result.running).toHaveLength(1);
    expect(result.running[0].id).toBe("passive:orch:a1");
  });

  it("LoopRun 覆盖对应编排 parent", () => {
    const result = buildTaskProjection({
      ...empty,
      bgTasks: {},
      aiTasks: {
        orch1: {
          id: "orch1",
          conversationId: null,
          title: "Loop parent",
          kind: "loop",
          status: "running",
          children: [],
          startedAt: 1,
        },
      },
      loopRuns: {
        r1: {
          id: "r1",
          loopId: "loop-db-health",
          status: "running",
          startedAt: 1,
          turns: [],
          findingIds: [],
          parentTaskId: "orch1",
        },
      },
      findings: {},
    });
    expect(result.running).toHaveLength(1);
    expect(result.running[0].facet).toBe("active_job");
    expect(result.running[0].id).toBe("active:loop:r1");
  });

  it("合并 bgHistory 终态任务", () => {
    const result = buildTaskProjection({
      ...empty,
      bgTasks: {},
      bgHistory: {
        h1: {
          id: "h1",
          module: "database",
          kind: "dbMysqlExport",
          title: "导出完成",
          progress: "",
          status: "completed",
          index: 1,
          total: 1,
          startedAt: 1,
          finishedAt: 2,
        },
      },
      aiTasks: {},
      loopRuns: {},
      findings: {},
      workflowExecs: {},
    });
    expect(result.historyJobs.some((j) => j.id === "passive:bg:h1")).toBe(true);
  });
});

describe("finding merge", () => {
  it("同 fingerprint 合并计数，已关闭则复活", () => {
    useLoopStore.setState({ findings: {}, runs: {}, specs: {} });
    const fp = findingFingerprint({
      loopId: "loop-db-health",
      resourceType: "db",
      resourceId: "c1",
      title: "慢查询",
    });
    useLoopStore.getState().addFindings([
      {
        id: "f1",
        loopId: "loop-db-health",
        runId: "r1",
        title: "慢查询",
        summary: "第一次",
        severity: "warning",
        status: "open",
        resourceType: "db",
        resourceId: "c1",
        fingerprint: fp,
        occurrenceCount: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    useLoopStore.getState().addFindings([
      {
        id: "f2",
        loopId: "loop-db-health",
        runId: "r2",
        title: "慢查询",
        summary: "第二次",
        severity: "warning",
        status: "open",
        resourceType: "db",
        resourceId: "c1",
        fingerprint: fp,
        occurrenceCount: 1,
        createdAt: 2,
        updatedAt: 2,
      },
    ]);
    let open = useLoopStore.getState().listOpenFindings();
    expect(open).toHaveLength(1);
    expect(open[0].occurrenceCount).toBe(2);
    expect(open[0].summary).toBe("第二次");

    useLoopStore.getState().triageFinding(open[0].id, "done");
    useLoopStore.getState().addFindings([
      {
        id: "f3",
        loopId: "loop-db-health",
        runId: "r3",
        title: "慢查询",
        summary: "第三次",
        severity: "critical",
        status: "open",
        resourceType: "db",
        resourceId: "c1",
        fingerprint: fp,
        occurrenceCount: 1,
        createdAt: 3,
        updatedAt: 3,
      },
    ]);
    open = useLoopStore.getState().listOpenFindings();
    expect(open).toHaveLength(1);
    expect(open[0].status).toBe("open");
    expect(open[0].occurrenceCount).toBe(3);
    expect(open[0].severity).toBe("critical");
  });
});
