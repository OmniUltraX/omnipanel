import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import {
  createLoopSpec,
  type LoopFinding,
  type LoopFindingStatus,
  type LoopRun,
  type LoopSpec,
} from "../lib/ai/loopSpec";
import { BUILTIN_LOOP_SPECS } from "../lib/ai/loopPilots";

interface LoopStoreState {
  specs: Record<string, LoopSpec>;
  runs: Record<string, LoopRun>;
  findings: Record<string, LoopFinding>;
  upsertSpec: (spec: LoopSpec) => void;
  setSpecEnabled: (id: string, enabled: boolean) => void;
  ensureBuiltinSpecs: () => void;
  addRun: (run: LoopRun) => void;
  updateRun: (id: string, patch: Partial<LoopRun>) => void;
  addFindings: (items: LoopFinding[]) => void;
  updateFinding: (id: string, patch: Partial<LoopFinding>) => void;
  triageFinding: (id: string, status: LoopFindingStatus) => void;
  listOpenFindings: () => LoopFinding[];
  listRunsForLoop: (loopId: string) => LoopRun[];
}

let seq = 0;
export function genLoopRunId(): string {
  return `loop_run_${Date.now()}_${++seq}`;
}
export function genFindingId(): string {
  return `finding_${Date.now()}_${++seq}`;
}

export const useLoopStore = create<LoopStoreState>()(
  persist(
    (set, get) => ({
      specs: {},
      runs: {},
      findings: {},
      upsertSpec: (spec) =>
        set((s) => ({
          specs: { ...s.specs, [spec.id]: { ...spec, updatedAt: Date.now() } },
        })),
      setSpecEnabled: (id, enabled) =>
        set((s) => {
          const cur = s.specs[id];
          if (!cur) return s;
          return {
            specs: {
              ...s.specs,
              [id]: { ...cur, enabled, updatedAt: Date.now() },
            },
          };
        }),
      ensureBuiltinSpecs: () => {
        const cur = get().specs;
        const next = { ...cur };
        let changed = false;
        for (const builtin of BUILTIN_LOOP_SPECS) {
          if (!next[builtin.id]) {
            next[builtin.id] = createLoopSpec(builtin);
            changed = true;
          }
        }
        if (changed) set({ specs: next });
      },
      addRun: (run) => set((s) => ({ runs: { ...s.runs, [run.id]: run } })),
      updateRun: (id, patch) =>
        set((s) => {
          const cur = s.runs[id];
          if (!cur) return s;
          return { runs: { ...s.runs, [id]: { ...cur, ...patch } } };
        }),
      addFindings: (items) =>
        set((s) => {
          const findings = { ...s.findings };
          for (const item of items) findings[item.id] = item;
          return { findings };
        }),
      updateFinding: (id, patch) =>
        set((s) => {
          const cur = s.findings[id];
          if (!cur) return s;
          return {
            findings: {
              ...s.findings,
              [id]: { ...cur, ...patch, updatedAt: Date.now() },
            },
          };
        }),
      triageFinding: (id, status) => {
        get().updateFinding(id, { status });
      },
      listOpenFindings: () =>
        Object.values(get().findings)
          .filter((f) => f.status === "open" || f.status === "triaged" || f.status === "blocked")
          .sort((a, b) => b.createdAt - a.createdAt),
      listRunsForLoop: (loopId) =>
        Object.values(get().runs)
          .filter((r) => r.loopId === loopId)
          .sort((a, b) => b.startedAt - a.startedAt),
    }),
    {
      name: "omnipanel-ai-loops.v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        specs: s.specs,
        runs: s.runs,
        findings: s.findings,
      }),
    },
  ),
);
