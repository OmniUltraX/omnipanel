import { create } from "zustand";
import type { IMarker } from "@xterm/xterm";
import type { DangerLevel } from "../lib/commandGuard";
import { recordTerminalSessionActivity } from "./terminalSessionActivity";
import {
  createEmptyOutputModel,
  flattenOutputModel,
  ingestTerminalOutputChunk,
  type TerminalOutputModel,
} from "../modules/terminal/terminalOutputModel";

export type TerminalBlockKind = "shell" | "ai";

export type AiThreadToolCallStatus =
  | "pending"
  | "running"
  | "completed"
  | "rejected"
  | "failed";

export interface AiThreadMessage {
  kind: "message";
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  timestamp: number;
}

export interface AiThreadToolCall {
  kind: "tool_call";
  id: string;
  toolName: string;
  args: string;
  command?: string;
  status: AiThreadToolCallStatus;
  result?: string;
  shellBlockId?: string;
  actionId?: string;
  riskLevel?: DangerLevel;
  timestamp: number;
}

export type AiThreadItem = AiThreadMessage | AiThreadToolCall;

/** @deprecated 使用 AiThreadMessage */
export type AiThreadTurn = AiThreadMessage;

export interface TerminalBlock {
  id: string;
  sessionId: string;
  kind?: TerminalBlockKind;
  title?: string;
  command: string;
  /** shell 块输出；AI 块不使用 */
  output: string;
  /** 运行期输出（支持 `\r` 当前行覆盖）；完成时压平到 output */
  liveOutput?: TerminalOutputModel;
  /** shell 块不使用 */
  reasoning?: string;
  aiThread?: AiThreadItem[];
  exitCode: number | null;
  startLine: number;
  endLine: number;
  marker: IMarker | null;
  cwd: string;
  timestamp: number;
  completedAt?: number;
  status: "running" | "completed" | "failed";
  /** UI 拉取的目录列表（不经过 shell ls 输出） */
  attachedListing?: import("../modules/terminal/lsListing/parseLsListing").LsListing;
  /** 仅展示目录列表，无命令行 */
  directoryPreview?: boolean;
  /** 系统静默执行（如 auto-ls），不触发 AI 自动命名等用户可见行为 */
  silent?: boolean;
}

const MAX_BLOCK_OUTPUT_CHARS = 64_000;

export const EMPTY_TERMINAL_BLOCKS: TerminalBlock[] = [];

interface BlocksState {
  blocks: Record<string, TerminalBlock[]>;

  addBlock: (sessionId: string, block: TerminalBlock) => void;
  updateBlock: (blockId: string, update: Partial<TerminalBlock>) => void;
  appendBlockOutput: (blockId: string, chunk: string) => void;
  appendBlockLiveOutput: (blockId: string, chunk: string) => void;
  appendBlockReasoning: (blockId: string, chunk: string) => void;
  pushAiThreadItem: (
    blockId: string,
    item:
      | (Omit<AiThreadMessage, "id" | "timestamp"> & { id?: string; timestamp?: number })
      | (Omit<AiThreadToolCall, "id" | "timestamp"> & { id?: string; timestamp?: number }),
  ) => string;
  updateAiThreadItem: (
    blockId: string,
    itemId: string,
    patch: Partial<AiThreadMessage> | Partial<AiThreadToolCall>,
  ) => void;
  appendAiThreadMessageField: (
    blockId: string,
    messageId: string,
    field: "content" | "reasoning",
    chunk: string,
  ) => void;
  /** 同步写入 AI 线程字段（流式缓冲 flush 时使用） */
  appendAiThreadMessageFieldSync: (
    blockId: string,
    messageId: string,
    field: "content" | "reasoning",
    chunk: string,
  ) => void;
  /** @deprecated 使用 pushAiThreadItem */
  pushAiThreadTurn: (
    blockId: string,
    turn: Omit<AiThreadMessage, "kind" | "id" | "timestamp"> & {
      id?: string;
      timestamp?: number;
    },
  ) => string;
  /** @deprecated 使用 appendAiThreadMessageField */
  appendAiThreadField: (
    blockId: string,
    turnId: string,
    field: "content" | "reasoning",
    chunk: string,
  ) => void;
  findBlockById: (blockId: string) => TerminalBlock | null;
  getBlocks: (sessionId: string) => TerminalBlock[];
  getLastBlock: (sessionId: string) => TerminalBlock | null;
  getLastError: (sessionId: string) => TerminalBlock | null;
  clearBlocks: (sessionId: string) => void;
  replaceSessionBlocks: (sessionId: string, blocks: TerminalBlock[]) => void;
  removeBlock: (blockId: string) => void;
}

let blockCounter = 0;

export function syncBlockCounterFromIds(blocks: Array<{ id: string }>): void {
  let max = blockCounter;
  for (const block of blocks) {
    const match = /^blk-(\d+)$/.exec(block.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  blockCounter = max;
}

export function createBlockId(): string {
  return `blk-${++blockCounter}`;
}

function dedupeBlocksById(blocks: TerminalBlock[]): TerminalBlock[] {
  const seen = new Set<string>();
  const result: TerminalBlock[] = [];
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (seen.has(block.id)) continue;
    seen.add(block.id);
    result.unshift(block);
  }
  return result;
}

function mapBlockThread(
  blocks: TerminalBlock[],
  blockId: string,
  mapper: (thread: AiThreadItem[]) => AiThreadItem[],
): TerminalBlock[] {
  return blocks.map((b) =>
    b.id === blockId ? { ...b, aiThread: mapper(b.aiThread ?? []) } : b,
  );
}

function findSessionIdForBlock(
  blocks: Record<string, TerminalBlock[]>,
  blockId: string,
): string | null {
  for (const [sessionId, sessionBlocks] of Object.entries(blocks)) {
    if (sessionBlocks.some((block) => block.id === blockId)) {
      return sessionId;
    }
  }
  return null;
}

function patchSessionBlockThread(
  blocks: Record<string, TerminalBlock[]>,
  blockId: string,
  mapper: (thread: AiThreadItem[]) => AiThreadItem[],
): Record<string, TerminalBlock[]> | null {
  const sessionId = findSessionIdForBlock(blocks, blockId);
  if (!sessionId) return null;
  return {
    ...blocks,
    [sessionId]: mapBlockThread(blocks[sessionId], blockId, mapper),
  };
}

function appendAiThreadMessageFieldToThread(
  thread: AiThreadItem[],
  messageId: string,
  field: "content" | "reasoning",
  chunk: string,
): AiThreadItem[] {
  return thread.map((item) => {
    if (item.id !== messageId || item.kind !== "message") return item;
    if (field === "content") {
      let content = item.content + chunk;
      if (content.length > MAX_BLOCK_OUTPUT_CHARS) {
        content = `…[输出已截断]\n${content.slice(-MAX_BLOCK_OUTPUT_CHARS)}`;
      }
      return { ...item, content };
    }
    let reasoning = (item.reasoning ?? "") + chunk;
    if (reasoning.length > MAX_BLOCK_OUTPUT_CHARS) {
      reasoning = `…[推理已截断]\n${reasoning.slice(-MAX_BLOCK_OUTPUT_CHARS)}`;
    }
    return { ...item, reasoning };
  });
}

export const useBlocksStore = create<BlocksState>((set, get) => ({
  blocks: {},

  addBlock: (sessionId, block) => {
    recordTerminalSessionActivity(sessionId, block.timestamp, { command: block.command });
    syncBlockCounterFromIds([block]);
    return set((state) => {
      const sessionBlocks = state.blocks[sessionId] || [];
      const existingIndex = sessionBlocks.findIndex((item) => item.id === block.id);
      const nextBlocks =
        existingIndex >= 0
          ? sessionBlocks.map((item, index) => (index === existingIndex ? block : item))
          : [...sessionBlocks, block];
      return {
        blocks: {
          ...state.blocks,
          [sessionId]: nextBlocks,
        },
      };
    });
  },

  updateBlock: (blockId, update) =>
    set((state) => {
      const newBlocks: Record<string, TerminalBlock[]> = {};
      const patch = { ...update };
      if (
        (patch.status === "completed" || patch.status === "failed") &&
        patch.completedAt === undefined
      ) {
        const existing = get().findBlockById(blockId);
        if (existing && !existing.completedAt) {
          patch.completedAt = Date.now();
        }
      }
      for (const [sid, blocks] of Object.entries(state.blocks)) {
        newBlocks[sid] = blocks.map((b) => {
          if (b.id !== blockId) return b;
          let next = { ...b, ...patch };
          if (
            (patch.status === "completed" || patch.status === "failed") &&
            next.liveOutput
          ) {
            const flattened = flattenOutputModel(next.liveOutput);
            if (flattened && !patch.output) {
              next = { ...next, output: flattened };
            }
            const { liveOutput: _removed, ...rest } = next;
            next = rest as TerminalBlock;
          }
          if (patch.status === "completed" || patch.status === "failed" || patch.completedAt != null) {
            recordTerminalSessionActivity(sid, next.completedAt ?? Date.now(), {
              command: next.command,
            });
          }
          return next;
        });
      }
      return { blocks: newBlocks };
    }),

  appendBlockOutput: (blockId, chunk) => {
    if (!chunk) return;
    set((state) => {
      const newBlocks: Record<string, TerminalBlock[]> = {};
      for (const [sid, blocks] of Object.entries(state.blocks)) {
        newBlocks[sid] = blocks.map((b) => {
          if (b.id !== blockId) return b;
          recordTerminalSessionActivity(sid, Date.now(), { command: b.command });
          let output = b.output + chunk;
          if (output.length > MAX_BLOCK_OUTPUT_CHARS) {
            output = `…[输出已截断]\n${output.slice(-MAX_BLOCK_OUTPUT_CHARS)}`;
          }
          return { ...b, output };
        });
      }
      return { blocks: newBlocks };
    });
  },

  appendBlockLiveOutput: (blockId, chunk) => {
    if (!chunk) return;
    set((state) => {
      const newBlocks: Record<string, TerminalBlock[]> = {};
      for (const [sid, blocks] of Object.entries(state.blocks)) {
        newBlocks[sid] = blocks.map((b) => {
          if (b.id !== blockId) return b;
          recordTerminalSessionActivity(sid, Date.now(), { command: b.command });
          const liveOutput = ingestTerminalOutputChunk(
            b.liveOutput ?? createEmptyOutputModel(),
            chunk,
          );
          return { ...b, liveOutput };
        });
      }
      return { blocks: newBlocks };
    });
  },

  appendBlockReasoning: (blockId, chunk) => {
    if (!chunk) return;
    set((state) => {
      const newBlocks: Record<string, TerminalBlock[]> = {};
      for (const [sid, blocks] of Object.entries(state.blocks)) {
        newBlocks[sid] = blocks.map((b) => {
          if (b.id !== blockId) return b;
          let reasoning = (b.reasoning ?? "") + chunk;
          if (reasoning.length > MAX_BLOCK_OUTPUT_CHARS) {
            reasoning = `…[推理已截断]\n${reasoning.slice(-MAX_BLOCK_OUTPUT_CHARS)}`;
          }
          return { ...b, reasoning };
        });
      }
      return { blocks: newBlocks };
    });
  },

  pushAiThreadItem: (blockId, item) => {
    const itemId = item.id ?? createBlockId();
    const fullItem = {
      ...item,
      id: itemId,
      timestamp: item.timestamp ?? Date.now(),
    } as AiThreadItem;
    set((state) => {
      const nextBlocks = patchSessionBlockThread(state.blocks, blockId, (thread) => [
        ...thread,
        fullItem,
      ]);
      if (!nextBlocks) return state;
      return { blocks: nextBlocks };
    });
    return itemId;
  },

  updateAiThreadItem: (blockId, itemId, patch) => {
    set((state) => {
      const nextBlocks = patchSessionBlockThread(state.blocks, blockId, (thread) =>
        thread.map((item) =>
          item.id === itemId ? ({ ...item, ...patch } as AiThreadItem) : item,
        ),
      );
      if (!nextBlocks) return state;
      return { blocks: nextBlocks };
    });
  },

  appendAiThreadMessageFieldSync: (blockId, messageId, field, chunk) => {
    if (!chunk) return;
    set((state) => {
      const nextBlocks = patchSessionBlockThread(state.blocks, blockId, (thread) =>
        appendAiThreadMessageFieldToThread(thread, messageId, field, chunk),
      );
      if (!nextBlocks) return state;
      return { blocks: nextBlocks };
    });
  },

  appendAiThreadMessageField: (blockId, messageId, field, chunk) => {
    get().appendAiThreadMessageFieldSync(blockId, messageId, field, chunk);
  },

  pushAiThreadTurn: (blockId, turn) =>
    get().pushAiThreadItem(blockId, {
      kind: "message",
      role: turn.role,
      content: turn.content,
      reasoning: turn.reasoning,
      id: turn.id,
      timestamp: turn.timestamp,
    }),

  appendAiThreadField: (blockId, turnId, field, chunk) => {
    get().appendAiThreadMessageField(blockId, turnId, field, chunk);
  },

  findBlockById: (blockId) => {
    for (const blocks of Object.values(get().blocks)) {
      const found = blocks.find((b) => b.id === blockId);
      if (found) return found;
    }
    return null;
  },

  getBlocks: (sessionId) => get().blocks[sessionId] ?? EMPTY_TERMINAL_BLOCKS,

  getLastBlock: (sessionId) => {
    const blocks = get().blocks[sessionId] || [];
    return blocks.length > 0 ? blocks[blocks.length - 1] : null;
  },

  getLastError: (sessionId) => {
    const blocks = get().blocks[sessionId] || [];
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (
        blocks[i].status === "failed" ||
        (blocks[i].exitCode !== null && blocks[i].exitCode !== 0)
      ) {
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

  replaceSessionBlocks: (sessionId, blocks) => {
    const normalized = dedupeBlocksById(blocks).map((block) => ({ ...block, marker: null }));
    syncBlockCounterFromIds(normalized);
    return set((state) => ({
      blocks: {
        ...state.blocks,
        [sessionId]: normalized,
      },
    }));
  },

  removeBlock: (blockId) =>
    set((state) => {
      const newBlocks: Record<string, TerminalBlock[]> = {};
      for (const [sid, blocks] of Object.entries(state.blocks)) {
        newBlocks[sid] = blocks.filter((block) => block.id !== blockId);
      }
      return { blocks: newBlocks };
    }),
}));

export function isAiThreadMessage(item: AiThreadItem): item is AiThreadMessage {
  return item.kind === "message";
}

export function isAiThreadToolCall(item: AiThreadItem): item is AiThreadToolCall {
  return item.kind === "tool_call";
}
