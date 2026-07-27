import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAiOrchestrationStore } from "../../../stores/aiOrchestrationStore";
import { useBackgroundTaskStore } from "../../../stores/backgroundTaskStore";
import { useBgTaskHistoryStore } from "../../../stores/bgTaskHistoryStore";
import { useLoopStore } from "../../../stores/loopStore";
import { useActionDraftStore } from "../../../stores/actionDraftStore";
import { useWorkflowLiveStore } from "../../../stores/workflowLiveStore";
import { useWorkflowStore } from "../../../stores/workflowStore";
import { buildTaskProjection } from "./buildTaskProjection";
import type { RunningFilter, TaskItem } from "../types";

/** 订阅多源 store，投影为运行中 / 待办 / 历史任务（不含审批进 inbox） */
export function useTaskCenterProjection() {
  const bgTasks = useBackgroundTaskStore((s) => s.tasks);
  const bgHistory = useBgTaskHistoryStore((s) => s.history);
  const aiTasks = useAiOrchestrationStore((s) => s.tasks);
  const clusters = useAiOrchestrationStore((s) => s.clusters);
  const loopRuns = useLoopStore((s) => s.runs);
  const findings = useLoopStore((s) => s.findings);
  const loopSpecs = useLoopStore((s) => s.specs);
  const workflowExecs = useWorkflowLiveStore((s) => s.byId);
  const workflows = useWorkflowStore((s) => s.workflows);
  const approvalCount = useActionDraftStore((s) => s.drafts.length);

  const workflowTitles = useMemo(() => {
    const map: Record<string, string> = {};
    for (const w of workflows) map[w.id] = w.name;
    return map;
  }, [workflows]);

  const loopTitles = useMemo(() => {
    const map: Record<string, string> = {};
    for (const s of Object.values(loopSpecs)) map[s.id] = s.name;
    return map;
  }, [loopSpecs]);

  const projection = useMemo(
    () =>
      buildTaskProjection({
        bgTasks,
        bgHistory,
        aiTasks,
        clusters,
        loopRuns,
        findings,
        workflowExecs,
        workflowTitles,
        loopTitles,
      }),
    [bgTasks, bgHistory, aiTasks, clusters, loopRuns, findings, workflowExecs, workflowTitles, loopTitles],
  );

  return { ...projection, approvalCount };
}

export function filterRunning(items: TaskItem[], filter: RunningFilter): TaskItem[] {
  if (filter === "passive") return items.filter((i) => i.facet === "passive_job");
  if (filter === "active") return items.filter((i) => i.facet === "active_job");
  return items;
}

export function useInboxFindingsRaw() {
  return useLoopStore(
    useShallow((s) =>
      Object.values(s.findings)
        .filter(
          (f) => f.status === "open" || f.status === "triaged" || f.status === "blocked",
        )
        .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt)),
    ),
  );
}
