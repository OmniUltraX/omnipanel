import { create } from "zustand";
import type { IMarker } from "@xterm/xterm";

export interface TerminalBlock {
  id: string;
  sessionId: string;
  command: string;
  output: string;
  exitCode: number | null;
  startLine: number;
  endLine: number;
  marker: IMarker | null;
  cwd: string;
  timestamp: number;
  status: "running" | "completed" | "failed";
}

interface BlocksState {
  blocks: Record<string, TerminalBlock[]>; // sessionId -> blocks

  addBlock: (sessionId: string, block: TerminalBlock) => void;
  updateBlock: (blockId: string, update: Partial<TerminalBlock>) => void;
  getBlocks: (sessionId: string) => TerminalBlock[];
  getLastBlock: (sessionId: string) => TerminalBlock | null;
  getLastError: (sessionId: string) => TerminalBlock | null;
  clearBlocks: (sessionId: string) => void;
}

let blockCounter = 0;

export function createBlockId(): string {
  return `blk-${++blockCounter}`;
}

export const useBlocksStore = create<BlocksState>((set, get) => ({
  blocks: {},

  addBlock: (sessionId, block) =>
    set((state) => ({
      blocks: {
        ...state.blocks,
        [sessionId]: [...(state.blocks[sessionId] || []), block],
      },
    })),

  updateBlock: (blockId, update) =>
    set((state) => {
      const newBlocks: Record<string, TerminalBlock[]> = {};
      for (const [sid, blocks] of Object.entries(state.blocks)) {
        newBlocks[sid] = blocks.map((b) =>
          b.id === blockId ? { ...b, ...update } : b
        );
      }
      return { blocks: newBlocks };
    }),

  getBlocks: (sessionId) => get().blocks[sessionId] || [],

  getLastBlock: (sessionId) => {
    const blocks = get().blocks[sessionId] || [];
    return blocks.length > 0 ? blocks[blocks.length - 1] : null;
  },

  getLastError: (sessionId) => {
    const blocks = get().blocks[sessionId] || [];
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].status === "failed" || (blocks[i].exitCode !== null && blocks[i].exitCode !== 0)) {
        return blocks[i];
      }
    }
    return null;
  },

  clearBlocks: (sessionId) =>
    set((state) => {
      const newBlocks = { ...state.blocks };
      delete newBlocks[sessionId];
      return { blocks: newBlocks };
    }),
}));
