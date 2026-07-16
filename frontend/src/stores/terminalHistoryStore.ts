import { create } from "zustand";
import type { TerminalBlock } from "./blocksStore";
import { useBlocksStore } from "./blocksStore";
import {
  fromHistoryRecord,
  persistedBlockToRecord,
  terminalHistoryRepo,
  toHistoryRecord,
} from "../modules/terminal/terminalHistoryRepo";
import { normalizeRestoredTerminalBlock } from "../modules/terminal/terminalBlockRestore";

/** 旧版 localStorage key；仅用于一次性迁移 */
export const TERMINAL_HISTORY_STORAGE_KEY = "omnipanel-terminal-history.v1";
export { DEFAULT_TERMINAL_HISTORY_MAX_BLOCKS } from "../modules/terminal/terminalHistoryRepo";

export type PersistedTerminalBlock = Omit<TerminalBlock, "marker"> & {
  marker: null;
};

interface TerminalHistoryState {
  /** 内存缓存：已加载/已同步的会话块（非持久化真相源） */
  bySession: Record<string, PersistedTerminalBlock[]>;
  sessionCount: number;
  blockCount: number;
  hydrated: boolean;
  refreshCounts: () => Promise<void>;
  /** 将 live blocks 写入缓存（sync flush 后调用） */
  cacheSessionBlocks: (sessionId: string, blocks: TerminalBlock[]) => void;
  restoreSession: (sessionId: string) => Promise<void>;
  restoreAllKnownSessions: (sessionIds: string[]) => Promise<void>;
  removeBlock: (sessionId: string, blockId: string) => Promise<void>;
  clearSession: (sessionId: string) => Promise<void>;
  clearAll: () => Promise<void>;
  getSessionBlocks: (sessionId: string) => PersistedTerminalBlock[];
  countBlocks: () => number;
  countSessions: () => number;
  /** 一次性：localStorage → SQLite */
  migrateFromLocalStorageIfNeeded: () => Promise<void>;
}

function fromPersistedTerminalBlock(block: PersistedTerminalBlock): TerminalBlock {
  return normalizeRestoredTerminalBlock(block);
}

export const useTerminalHistoryStore = create<TerminalHistoryState>((set, get) => ({
  bySession: {},
  sessionCount: 0,
  blockCount: 0,
  hydrated: false,

  refreshCounts: async () => {
    try {
      const { sessions, blocks } = await terminalHistoryRepo.counts();
      set({ sessionCount: sessions, blockCount: blocks, hydrated: true });
    } catch {
      set({ hydrated: true });
    }
  },

  cacheSessionBlocks: (sessionId, blocks) => {
    if (!sessionId) return;
    const persisted = blocks
      .filter((block) => block.command.trim().length > 0 || block.kind === "ai")
      .map((block) => {
        const record = toHistoryRecord(block);
        return fromHistoryRecord(record);
      });
    set((state) => ({
      bySession: {
        ...state.bySession,
        [sessionId]: persisted,
      },
    }));
  },

  restoreSession: async (sessionId) => {
    if (!sessionId) return;
    const store = useBlocksStore.getState();
    const current = store.getBlocks(sessionId);
    // 仅冷灌入：已有 live blocks 时不得 reconcile
    if (current.length > 0) return;

    let persisted = get().bySession[sessionId];
    if (!persisted?.length) {
      try {
        persisted = await terminalHistoryRepo.loadSession(sessionId);
      } catch {
        return;
      }
      if (!persisted.length) return;
      set((state) => ({
        bySession: { ...state.bySession, [sessionId]: persisted! },
      }));
    }

    const terminalBlocks = persisted.map(fromPersistedTerminalBlock);
    const { noteRestoredSessionBlocks } = await import("../modules/terminal/terminalHistorySync");
    noteRestoredSessionBlocks(sessionId, terminalBlocks);
    store.replaceSessionBlocks(sessionId, terminalBlocks);
  },

  restoreAllKnownSessions: async (sessionIds) => {
    for (const sessionId of sessionIds) {
      await get().restoreSession(sessionId);
    }
  },

  removeBlock: async (sessionId, blockId) => {
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
    try {
      await terminalHistoryRepo.removeBlock(sessionId, blockId);
      await get().refreshCounts();
    } catch {
      // ignore
    }
  },

  clearSession: async (sessionId) => {
    set((state) => {
      const next = { ...state.bySession };
      delete next[sessionId];
      return { bySession: next };
    });
    useBlocksStore.getState().clearBlocks(sessionId);
    try {
      await terminalHistoryRepo.clearSession(sessionId);
      await get().refreshCounts();
    } catch {
      // ignore
    }
  },

  clearAll: async () => {
    const sessionIds = Object.keys(get().bySession);
    set({ bySession: {}, sessionCount: 0, blockCount: 0 });
    for (const sessionId of sessionIds) {
      useBlocksStore.getState().clearBlocks(sessionId);
    }
    try {
      await terminalHistoryRepo.clearAll();
    } catch {
      // ignore
    }
  },

  getSessionBlocks: (sessionId) => get().bySession[sessionId] ?? [],

  countBlocks: () => get().blockCount,

  countSessions: () => get().sessionCount,

  migrateFromLocalStorageIfNeeded: async () => {
    if (typeof localStorage === "undefined") return;
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(TERMINAL_HISTORY_STORAGE_KEY);
    } catch {
      return;
    }
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw) as {
        state?: { bySession?: Record<string, PersistedTerminalBlock[]> };
        bySession?: Record<string, PersistedTerminalBlock[]>;
      };
      const bySession = parsed.state?.bySession ?? parsed.bySession ?? {};
      for (const [sessionId, blocks] of Object.entries(bySession)) {
        if (!sessionId || !blocks?.length) continue;
        const records = blocks.map((b) => persistedBlockToRecord(sessionId, b));
        await terminalHistoryRepo.upsertRecords(sessionId, records);
      }
      try {
        localStorage.removeItem(TERMINAL_HISTORY_STORAGE_KEY);
      } catch {
        // ignore
      }
      await get().refreshCounts();
    } catch (err) {
      console.warn("[terminal-history] localStorage 迁移失败，下次启动将重试", err);
    }
  },
}));

export function clearTerminalHistoryData(): void {
  void useTerminalHistoryStore.getState().clearAll();
}

/** @deprecated 截断已下沉到 Rust；保留导出以免外部引用断裂 */
export function toPersistedTerminalBlock(block: TerminalBlock): PersistedTerminalBlock {
  return fromHistoryRecord(toHistoryRecord(block));
}
