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
import { createIndexedDBStorage } from "../lib/indexedDbStorage";

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
  /** 批量分诊所有待处理 Finding（open / triaged / blocked） */
  triageOpenFindings: (status: LoopFindingStatus) => number;
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
          const openByFp = new Map<string, LoopFinding>();
          for (const f of Object.values(findings)) {
            if (!f.fingerprint) continue;
            if (f.status === "open" || f.status === "triaged" || f.status === "blocked") {
              openByFp.set(f.fingerprint, f);
            }
          }
          const closedByFp = new Map<string, LoopFinding>();
          for (const f of Object.values(findings)) {
            if (!f.fingerprint) continue;
            if (f.status === "done" || f.status === "dismissed") {
              const prev = closedByFp.get(f.fingerprint);
              if (!prev || (f.updatedAt ?? 0) > (prev.updatedAt ?? 0)) {
                closedByFp.set(f.fingerprint, f);
              }
            }
          }

          for (const item of items) {
            const fp = item.fingerprint;
            if (!fp) {
              findings[item.id] = item;
              continue;
            }
            const openHit = openByFp.get(fp);
            if (openHit) {
              const merged: LoopFinding = {
                ...openHit,
                summary: item.summary || openHit.summary,
                evidence: item.evidence ?? openHit.evidence,
                suggestedAction: item.suggestedAction ?? openHit.suggestedAction,
                severity: item.severity,
                runId: item.runId,
                occurrenceCount: (openHit.occurrenceCount ?? 1) + 1,
                updatedAt: Date.now(),
              };
              findings[openHit.id] = merged;
              openByFp.set(fp, merged);
              continue;
            }
            const closedHit = closedByFp.get(fp);
            if (closedHit) {
              const revived: LoopFinding = {
                ...closedHit,
                ...item,
                id: closedHit.id,
                status: "open",
                occurrenceCount: (closedHit.occurrenceCount ?? 1) + 1,
                createdAt: closedHit.createdAt,
                updatedAt: Date.now(),
              };
              findings[closedHit.id] = revived;
              openByFp.set(fp, revived);
              closedByFp.delete(fp);
              continue;
            }
            findings[item.id] = { ...item, occurrenceCount: item.occurrenceCount ?? 1 };
            openByFp.set(fp, findings[item.id]);
          }
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
      triageOpenFindings: (status) => {
        const open = get().listOpenFindings();
        if (open.length === 0) return 0;
        const now = Date.now();
        set((s) => {
          const findings = { ...s.findings };
          for (const f of open) {
            const cur = findings[f.id];
            if (!cur) continue;
            findings[f.id] = { ...cur, status, updatedAt: now };
          }
          return { findings };
        });
        return open.length;
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
      storage: createJSONStorage(createIndexedDBStorage),
      partialize: (s) => ({
        specs: s.specs,
        runs: s.runs,
        findings: s.findings,
      }),
    },
  ),
);
