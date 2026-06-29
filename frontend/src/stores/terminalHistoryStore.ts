import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { AiThreadItem, TerminalBlock } from "./blocksStore";
import { useBlocksStore } from "./blocksStore";
import { useSettingsStore } from "./settingsStore";

export const TERMINAL_HISTORY_STORAGE_KEY = "omnipanel-terminal-history.v1";
export const DEFAULT_TERMINAL_HISTORY_MAX_BLOCKS = 200;
const MAX_PERSISTED_OUTPUT_CHARS = 16_000;

export type PersistedTerminalBlock = Omit<TerminalBlock, "marker"> & {
  marker: null;
};

interface TerminalHistoryState {
  bySession: Record<string, PersistedTerminalBlock[]>;
  syncSession: (sessionId: string, blocks: TerminalBlock[]) => void;
  restoreSession: (sessionId: string) => void;
  restoreAllKnownSessions: (sessionIds: string[]) => void;
  removeBlock: (sessionId: string, blockId: string) => void;
  clearSession: (sessionId: string) => void;
  clearAll: () => void;
  getSessionBlocks: (sessionId: string) => PersistedTerminalBlock[];
  countBlocks: () => number;
  countSessions: () => number;
}

function trimOutput(text: string): string {
  if (text.length <= MAX_PERSISTED_OUTPUT_CHARS) return text;
  return `…[输出已截断]\n${text.slice(-MAX_PERSISTED_OUTPUT_CHARS)}`;
}

function trimAiThread(thread: AiThreadItem[] | undefined): AiThreadItem[] | undefined {
  if (!thread?.length) return thread;
  return thread.map((item) => {
    if (item.kind !== "message") {
      const result =
        item.result && item.result.length > MAX_PERSISTED_OUTPUT_CHARS
          ? `${item.result.slice(0, 2000)}…[结果已截断]`
          : item.result;
      return { ...item, result };
    }
    const content =
      item.content.length > MAX_PERSISTED_OUTPUT_CHARS
        ? `${item.content.slice(0, 2000)}…[内容已截断]`
        : item.content;
    const reasoning =
      item.reasoning && item.reasoning.length > MAX_PERSISTED_OUTPUT_CHARS
        ? `${item.reasoning.slice(0, 2000)}…[推理已截断]`
        : item.reasoning;
    return { ...item, content, reasoning };
  });
}

export function toPersistedTerminalBlock(block: TerminalBlock): PersistedTerminalBlock {
  return {
    ...block,
    marker: null,
    output: trimOutput(block.output),
    reasoning: block.reasoning ? trimOutput(block.reasoning) : block.reasoning,
    aiThread: trimAiThread(block.aiThread),
  };
}

function fromPersistedTerminalBlock(block: PersistedTerminalBlock): TerminalBlock {
  return {
    ...block,
    marker: null,
  };
}

function resolveMaxBlocks(): number {
  const configured = useSettingsStore.getState().terminalHistoryMaxBlocks;
  if (!Number.isFinite(configured) || configured < 1) {
    return DEFAULT_TERMINAL_HISTORY_MAX_BLOCKS;
  }
  return Math.min(500, Math.max(20, Math.round(configured)));
}

function shouldPersistHistory(): boolean {
  return useSettingsStore.getState().terminalHistoryPersist;
}

export const useTerminalHistoryStore = create<TerminalHistoryState>()(
  persist(
    (set, get) => ({
      bySession: {},

      syncSession: (sessionId, blocks) => {
        if (!shouldPersistHistory() || !sessionId) return;
        const maxBlocks = resolveMaxBlocks();
        const persisted = blocks
          .filter((block) => block.command.trim().length > 0 || block.kind === "ai")
          .slice(-maxBlocks)
          .map(toPersistedTerminalBlock);
        set((state) => ({
          bySession: {
            ...state.bySession,
            [sessionId]: persisted,
          },
        }));
      },

      restoreSession: (sessionId) => {
        if (!sessionId) return;
        const persisted = get().bySession[sessionId];
        if (!persisted?.length) return;
        const current = useBlocksStore.getState().getBlocks(sessionId);
        if (current.length > 0) return;
        useBlocksStore
          .getState()
          .replaceSessionBlocks(sessionId, persisted.map(fromPersistedTerminalBlock));
      },

      restoreAllKnownSessions: (sessionIds) => {
        for (const sessionId of sessionIds) {
          get().restoreSession(sessionId);
        }
      },

      removeBlock: (sessionId, blockId) => {
        set((state) => {
          const current = state.bySession[sessionId] ?? [];
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: current.filter((block) => block.id !== blockId),
            },
          };
        });
        useBlocksStore.getState().removeBlock(blockId);
      },

      clearSession: (sessionId) => {
        set((state) => {
          const next = { ...state.bySession };
          delete next[sessionId];
          return { bySession: next };
        });
        useBlocksStore.getState().clearBlocks(sessionId);
      },

      clearAll: () => {
        const sessionIds = Object.keys(get().bySession);
        set({ bySession: {} });
        for (const sessionId of sessionIds) {
          useBlocksStore.getState().clearBlocks(sessionId);
        }
      },

      getSessionBlocks: (sessionId) => get().bySession[sessionId] ?? [],

      countBlocks: () =>
        Object.values(get().bySession).reduce((sum, blocks) => sum + blocks.length, 0),

      countSessions: () => Object.keys(get().bySession).length,
    }),
    {
      name: TERMINAL_HISTORY_STORAGE_KEY,
      version: 2,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ bySession: state.bySession }),
      migrate: (persistedState, version) => {
        const persisted = persistedState as { bySession?: Record<string, PersistedTerminalBlock[]> };
        if (!persisted?.bySession || version >= 2) {
          return persistedState as TerminalHistoryState;
        }
        // v1 历史键即为 tab/session id，v2 起统一按 sessionId 存储，结构不变
        return { bySession: persisted.bySession } as TerminalHistoryState;
      },
    },
  ),
);

export function clearTerminalHistoryData(): void {
  useTerminalHistoryStore.getState().clearAll();
  useTerminalHistoryStore.persist.clearStorage();
}
