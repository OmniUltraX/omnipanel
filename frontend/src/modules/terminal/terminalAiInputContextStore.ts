import { create } from "zustand";
import { useBlocksStore } from "../../stores/blocksStore";
import { formatTerminalBlockForAiContext } from "./formatTerminalBlockForAiContext";

interface TerminalAiInputContextState {
  attachedBlockIds: Record<string, string[]>;
  attachVersion: Record<string, number>;
  attachBlock: (sessionId: string, blockId: string) => "added" | "duplicate";
  detachBlock: (sessionId: string, blockId: string) => void;
  clearAttached: (sessionId: string) => void;
  getAttachedBlockIds: (sessionId: string) => string[];
  consumeAttachedContext: (sessionId: string) => string | undefined;
}

function bumpAttachVersion(
  attachVersion: Record<string, number>,
  sessionId: string,
): Record<string, number> {
  return {
    ...attachVersion,
    [sessionId]: (attachVersion[sessionId] ?? 0) + 1,
  };
}

export const useTerminalAiInputContextStore = create<TerminalAiInputContextState>((set, get) => ({
  attachedBlockIds: {},
  attachVersion: {},

  attachBlock: (sessionId, blockId) => {
    const existing = get().attachedBlockIds[sessionId] ?? [];
    if (existing.includes(blockId)) return "duplicate";
    set((state) => ({
      attachedBlockIds: {
        ...state.attachedBlockIds,
        [sessionId]: [...existing, blockId],
      },
      attachVersion: bumpAttachVersion(state.attachVersion, sessionId),
    }));
    return "added";
  },

  detachBlock: (sessionId, blockId) =>
    set((state) => {
      const existing = state.attachedBlockIds[sessionId] ?? [];
      const next = existing.filter((id) => id !== blockId);
      const attachedBlockIds = { ...state.attachedBlockIds };
      if (next.length === 0) {
        delete attachedBlockIds[sessionId];
      } else {
        attachedBlockIds[sessionId] = next;
      }
      return {
        attachedBlockIds,
        attachVersion: bumpAttachVersion(state.attachVersion, sessionId),
      };
    }),

  clearAttached: (sessionId) =>
    set((state) => {
      const attachedBlockIds = { ...state.attachedBlockIds };
      delete attachedBlockIds[sessionId];
      return {
        attachedBlockIds,
        attachVersion: bumpAttachVersion(state.attachVersion, sessionId),
      };
    }),

  getAttachedBlockIds: (sessionId) => get().attachedBlockIds[sessionId] ?? [],

  consumeAttachedContext: (sessionId) => {
    const blockIds = get().attachedBlockIds[sessionId] ?? [];
    if (blockIds.length === 0) return undefined;

    set((state) => {
      const attachedBlockIds = { ...state.attachedBlockIds };
      delete attachedBlockIds[sessionId];
      return {
        attachedBlockIds,
        attachVersion: bumpAttachVersion(state.attachVersion, sessionId),
      };
    });

    const parts = blockIds
      .map((blockId) => useBlocksStore.getState().findBlockById(blockId))
      .filter((block): block is NonNullable<typeof block> => block !== null)
      .map((block) => formatTerminalBlockForAiContext(block).trim())
      .filter(Boolean);

    if (parts.length === 0) return undefined;
    return parts.join("\n\n---\n\n");
  },
}));
