import {
  commands,
  type TerminalHistoryBlockRecord,
  type TerminalHistoryRetainPolicy,
} from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import type { AiThreadItem, TerminalBlock, TerminalBlockKind } from "../../stores/blocksStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { renderLiveOutputText } from "./terminalOutputModel";
import type { PersistedTerminalBlock } from "../../stores/terminalHistoryStore";

export const DEFAULT_TERMINAL_HISTORY_MAX_BLOCKS = 200;
export const DEFAULT_TERMINAL_HISTORY_MAX_SESSIONS = 24;

export type TerminalHistoryPayload = {
  output: string;
  reasoning?: string;
  aiThread?: AiThreadItem[];
  aiThreadSummary?: string;
  aiThreadSummaryForCount?: number;
  silent?: boolean;
  directoryPreview?: boolean;
  linkedTabId?: string;
  linkedTabTitle?: string;
  aiStalled?: boolean;
};

export function resolveHistoryPolicy(): TerminalHistoryRetainPolicy {
  const configured = useSettingsStore.getState().terminalHistoryMaxBlocks;
  const maxBlocks =
    !Number.isFinite(configured) || configured < 1
      ? DEFAULT_TERMINAL_HISTORY_MAX_BLOCKS
      : Math.min(500, Math.max(20, Math.round(configured)));
  return {
    maxSessions: DEFAULT_TERMINAL_HISTORY_MAX_SESSIONS,
    maxBlocksPerSession: maxBlocks,
  };
}

export function shouldPersistTerminalHistory(): boolean {
  return useSettingsStore.getState().terminalHistoryPersist;
}

/** 将 live block 转为落盘记录；截断由 Rust sanitize 统一执行。 */
export function toHistoryRecord(block: TerminalBlock): TerminalHistoryBlockRecord {
  const payload: TerminalHistoryPayload = {
    output: renderLiveOutputText(block.liveOutput, block.output),
    reasoning: block.reasoning,
    aiThread: block.aiThread,
    aiThreadSummary: block.aiThreadSummary,
    aiThreadSummaryForCount: block.aiThreadSummaryForCount,
    silent: block.silent,
    directoryPreview: block.directoryPreview,
    linkedTabId: block.linkedTabId,
    linkedTabTitle: block.linkedTabTitle,
    aiStalled: block.aiStalled,
  };
  return {
    id: block.id,
    sessionId: block.sessionId,
    kind: block.kind ?? "shell",
    command: block.command,
    title: block.title ?? null,
    status: block.status,
    exitCode: block.exitCode,
    cwd: block.cwd ?? "",
    timestamp: block.timestamp,
    completedAt: block.completedAt ?? null,
    payload: JSON.stringify(payload),
    updatedAt: Date.now(),
  };
}

export function fromHistoryRecord(record: TerminalHistoryBlockRecord): PersistedTerminalBlock {
  let payload: TerminalHistoryPayload = { output: "" };
  try {
    payload = JSON.parse(record.payload) as TerminalHistoryPayload;
  } catch {
    payload = { output: "" };
  }
  const kind = (record.kind === "ai" ? "ai" : "shell") as TerminalBlockKind;
  const status =
    record.status === "running" || record.status === "failed" || record.status === "completed"
      ? record.status
      : "completed";
  return {
    id: record.id,
    sessionId: record.sessionId,
    kind,
    title: record.title ?? undefined,
    command: record.command,
    output: payload.output ?? "",
    reasoning: payload.reasoning,
    aiThread: payload.aiThread,
    exitCode: record.exitCode,
    startLine: 0,
    endLine: 0,
    marker: null,
    cwd: record.cwd ?? "",
    timestamp: record.timestamp ?? Date.now(),
    completedAt: record.completedAt ?? undefined,
    status,
    silent: payload.silent,
    directoryPreview: payload.directoryPreview,
    linkedTabId: payload.linkedTabId,
    linkedTabTitle: payload.linkedTabTitle,
    aiThreadSummary: payload.aiThreadSummary,
    aiThreadSummaryForCount: payload.aiThreadSummaryForCount,
    aiStalled: payload.aiStalled,
  };
}

/** 旧 localStorage PersistedTerminalBlock → 落盘记录（迁移用） */
export function persistedBlockToRecord(
  sessionId: string,
  block: PersistedTerminalBlock,
): TerminalHistoryBlockRecord {
  const payload: TerminalHistoryPayload = {
    output: block.output ?? "",
    reasoning: block.reasoning,
    aiThread: block.aiThread,
    aiThreadSummary: block.aiThreadSummary,
    aiThreadSummaryForCount: block.aiThreadSummaryForCount,
    silent: block.silent,
    directoryPreview: block.directoryPreview,
    linkedTabId: block.linkedTabId,
    linkedTabTitle: block.linkedTabTitle,
    aiStalled: block.aiStalled,
  };
  return {
    id: block.id,
    sessionId,
    kind: block.kind ?? "shell",
    command: block.command ?? "",
    title: block.title ?? null,
    status: block.status ?? "completed",
    exitCode: block.exitCode,
    cwd: block.cwd ?? "",
    timestamp: block.timestamp ?? Date.now(),
    completedAt: block.completedAt ?? null,
    payload: JSON.stringify(payload),
    updatedAt: Date.now(),
  };
}

export const terminalHistoryRepo = {
  async loadSession(sessionId: string): Promise<PersistedTerminalBlock[]> {
    const rows = await unwrapCommand(commands.terminalHistoryLoadSession(sessionId));
    return rows.map(fromHistoryRecord);
  },

  async upsertBlocks(
    sessionId: string,
    blocks: TerminalBlock[],
    workspaceId?: string | null,
  ): Promise<void> {
    if (!shouldPersistTerminalHistory() || !sessionId || blocks.length === 0) return;
    const records = blocks
      .filter((b) => b.command.trim().length > 0 || b.kind === "ai")
      .map(toHistoryRecord);
    if (records.length === 0) return;
    await unwrapCommand(
      commands.terminalHistoryUpsertBlocks(
        sessionId,
        workspaceId ?? null,
        records,
        resolveHistoryPolicy(),
      ),
    );
  },

  async upsertRecords(
    sessionId: string,
    records: TerminalHistoryBlockRecord[],
    workspaceId?: string | null,
  ): Promise<void> {
    if (!sessionId || records.length === 0) return;
    await unwrapCommand(
      commands.terminalHistoryUpsertBlocks(
        sessionId,
        workspaceId ?? null,
        records,
        resolveHistoryPolicy(),
      ),
    );
  },

  async removeBlock(sessionId: string, blockId: string): Promise<void> {
    await unwrapCommand(commands.terminalHistoryRemoveBlock(sessionId, blockId));
  },

  async clearSession(sessionId: string): Promise<void> {
    await unwrapCommand(commands.terminalHistoryClearSession(sessionId));
  },

  async clearAll(): Promise<void> {
    await unwrapCommand(commands.terminalHistoryClearAll());
  },

  async counts(): Promise<{ sessions: number; blocks: number }> {
    const [sessions, blocks] = await unwrapCommand(commands.terminalHistoryCounts());
    return { sessions, blocks };
  },
};
