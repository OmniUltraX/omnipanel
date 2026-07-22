/**
 * LoopRunner：执行一轮 Outer Loop（discover → verify → persist）。
 * 写操作不自动执行；findings 进入 Triage。
 */
import { useAiOrchestrationStore } from "../../stores/aiOrchestrationStore";
import { genFindingId, genLoopRunId, useLoopStore } from "../../stores/loopStore";
import { materializeFindings, runPilotDiscover } from "./loopPilots";
import { shouldStopLoop, verifyLoopRun } from "./loopVerifier";
import type { LoopRun, LoopSpec } from "./loopSpec";

export interface RunLoopOptions {
  loopId: string;
  connectionId?: string;
  connectionName?: string;
}

export async function runLoopOnce(options: RunLoopOptions): Promise<LoopRun> {
  const store = useLoopStore.getState();
  store.ensureBuiltinSpecs();
  const spec = store.specs[options.loopId];
  if (!spec) {
    throw new Error(`未知 Loop：${options.loopId}`);
  }
  if (!spec.enabled) {
    throw new Error(`Loop 已禁用：${spec.name}`);
  }

  const runId = genLoopRunId();
  const parentTaskId = useAiOrchestrationStore.getState().createTask({
    id: `ai_task_loop_${runId}`,
    conversationId: null,
    title: `Loop · ${spec.name}`,
    kind: "loop",
    children: [
      { id: "discover", title: "Discover", status: "running" },
      { id: "verify", title: "Verify", status: "pending" },
    ],
  });

  const run: LoopRun = {
    id: runId,
    loopId: spec.id,
    status: "discovering",
    startedAt: Date.now(),
    turns: [],
    findingIds: [],
    parentTaskId,
  };
  store.addRun(run);

  try {
    // Discover
    let discoverSummary = "noop";
    let findings: ReturnType<typeof materializeFindings> = [];

    if (spec.pilotId) {
      const result = await runPilotDiscover(spec.pilotId, {
        loopId: spec.id,
        runId,
        connectionId: options.connectionId,
        connectionName: options.connectionName,
      });
      discoverSummary = result.summary;
      findings = materializeFindings(spec.id, runId, result.findings);
    } else {
      findings = [
        {
          id: genFindingId(),
          loopId: spec.id,
          runId,
          title: "未配置 pilot",
          summary: "请指定 pilotId 或后续接入 skill discover",
          severity: "warning" as const,
          status: "open" as const,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ];
      discoverSummary = "无 pilot";
    }

    store.addFindings(findings);
    const turnDiscover = {
      index: 0,
      phase: "discover" as const,
      summary: discoverSummary,
      ok: true,
      at: Date.now(),
    };
    store.updateRun(runId, {
      status: "verifying",
      turns: [turnDiscover],
      findingIds: findings.map((f) => f.id),
    });
    useAiOrchestrationStore.getState().updateChild(parentTaskId, "discover", {
      status: "completed",
      summary: discoverSummary,
    });
    useAiOrchestrationStore.getState().updateChild(parentTaskId, "verify", {
      status: "running",
    });

    // Verify（独立门，禁止 worker 自评）
    const latest = useLoopStore.getState().runs[runId]!;
    const allFindings = findings;
    const verify = verifyLoopRun({
      spec,
      run: latest,
      findings: allFindings,
    });
    const turnVerify = {
      index: 1,
      phase: "verify" as const,
      summary: verify.reason,
      ok: verify.passed,
      at: Date.now(),
    };

    const stop = shouldStopLoop(spec, { ...latest, turns: [turnDiscover, turnVerify] }, verify);
    const status = verify.passed ? "completed" : stop ? "stopped" : "completed";

    store.updateRun(runId, {
      status,
      turns: [turnDiscover, turnVerify],
      verifyPassed: verify.passed,
      finishedAt: Date.now(),
      error: verify.passed ? undefined : verify.reason,
    });

    useAiOrchestrationStore.getState().updateChild(parentTaskId, "verify", {
      status: verify.passed ? "completed" : "failed",
      summary: verify.reason,
      error: verify.passed ? undefined : verify.reason,
    });
    useAiOrchestrationStore.getState().setParentStatus(
      parentTaskId,
      verify.passed ? "completed" : "failed",
      verify.reason,
    );

    return useLoopStore.getState().runs[runId]!;
  } catch (e) {
    const message = String(e);
    store.updateRun(runId, {
      status: "failed",
      error: message,
      finishedAt: Date.now(),
    });
    useAiOrchestrationStore.getState().updateChild(parentTaskId, "discover", {
      status: "failed",
      error: message,
    });
    useAiOrchestrationStore.getState().setParentStatus(parentTaskId, "failed", message);
    throw e;
  }
}

/** 简单 interval 调度（应用内，非系统 cron）。 */
const timers = new Map<string, ReturnType<typeof setInterval>>();

export function startLoopScheduler(): void {
  const store = useLoopStore.getState();
  store.ensureBuiltinSpecs();
  for (const spec of Object.values(store.specs)) {
    if (!spec.enabled || !spec.intervalMs || spec.intervalMs < 60_000) continue;
    if (timers.has(spec.id)) continue;
    const handle = setInterval(() => {
      void runLoopOnce({ loopId: spec.id }).catch((err) => {
        console.warn(`[LoopScheduler] ${spec.id} 失败`, err);
      });
    }, spec.intervalMs);
    timers.set(spec.id, handle);
  }
}

export function stopLoopScheduler(): void {
  for (const h of timers.values()) clearInterval(h);
  timers.clear();
}
