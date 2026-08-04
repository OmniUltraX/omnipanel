import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { createSafeLocalStorage } from "../../lib/zustandPersistStorage";

export type TmuxPaneSessionBinding = {
  resourceId: string;
  tmuxSession: string;
  paneId: number;
  sessionId: string;
  updatedAt: number;
};

type TmuxPaneSessionIndexState = {
  bindings: TmuxPaneSessionBinding[];
  upsert: (binding: Omit<TmuxPaneSessionBinding, "updatedAt"> & { updatedAt?: number }) => void;
  find: (
    resourceId: string,
    tmuxSession: string,
    paneId: number,
  ) => TmuxPaneSessionBinding | null;
  findBySessionId: (sessionId: string) => TmuxPaneSessionBinding | null;
  listForSession: (resourceId: string, tmuxSession: string) => TmuxPaneSessionBinding[];
  removeBySessionId: (sessionId: string) => void;
  latestForSession: (resourceId: string, tmuxSession: string) => TmuxPaneSessionBinding | null;
};

function bindingKey(resourceId: string, tmuxSession: string, paneId: number): string {
  return `${resourceId}::${tmuxSession}::${paneId}`;
}

export const useTmuxPaneSessionIndex = create<TmuxPaneSessionIndexState>()(
  persist(
    (set, get) => ({
      bindings: [],

      upsert: (binding) => {
        if (!binding.resourceId || !binding.tmuxSession || !binding.sessionId) return;
        if (!Number.isFinite(binding.paneId)) return;
        const key = bindingKey(binding.resourceId, binding.tmuxSession, binding.paneId);
        const nextItem: TmuxPaneSessionBinding = {
          resourceId: binding.resourceId,
          tmuxSession: binding.tmuxSession,
          paneId: binding.paneId,
          sessionId: binding.sessionId,
          updatedAt: binding.updatedAt ?? Date.now(),
        };
        set((state) => {
          const filtered = state.bindings.filter(
            (item) =>
              bindingKey(item.resourceId, item.tmuxSession, item.paneId) !== key &&
              item.sessionId !== binding.sessionId,
          );
          return { bindings: [...filtered, nextItem] };
        });
      },

      find: (resourceId, tmuxSession, paneId) =>
        get().bindings.find(
          (item) =>
            item.resourceId === resourceId &&
            item.tmuxSession === tmuxSession &&
            item.paneId === paneId,
        ) ?? null,

      findBySessionId: (sessionId) =>
        get().bindings.find((item) => item.sessionId === sessionId) ?? null,

      listForSession: (resourceId, tmuxSession) =>
        get().bindings.filter(
          (item) => item.resourceId === resourceId && item.tmuxSession === tmuxSession,
        ),

      removeBySessionId: (sessionId) =>
        set((state) => ({
          bindings: state.bindings.filter((item) => item.sessionId !== sessionId),
        })),

      latestForSession: (resourceId, tmuxSession) => {
        const list = get().listForSession(resourceId, tmuxSession);
        if (list.length === 0) return null;
        return list.reduce((best, item) =>
          item.updatedAt > best.updatedAt ? item : best,
        );
      },
    }),
    {
      name: "omnipanel-tmux-pane-session-index.v1",
      storage: createJSONStorage(createSafeLocalStorage),
      partialize: (state) => ({ bindings: state.bindings }),
    },
  ),
);

/** 在拿到 paneId 后登记绑定（供 useTerminal / attach 调用） */
export function upsertTmuxPaneSessionBinding(
  resourceId: string,
  tmuxSession: string | null | undefined,
  paneId: number | null | undefined,
  sessionId: string,
): void {
  if (!resourceId || !tmuxSession || paneId == null || !Number.isFinite(paneId) || !sessionId) {
    return;
  }
  useTmuxPaneSessionIndex.getState().upsert({
    resourceId,
    tmuxSession,
    paneId,
    sessionId,
  });
}
