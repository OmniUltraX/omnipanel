import { stripTerminalControlSequences } from "../terminalOutputText";
import { invalidateSessionHistoryIndex } from "./historyIndexCache";
import { normalizeHistoryCommands } from "./internalHistoryCommands";
import { useSessionShellHistoryStore } from "./sessionShellHistoryStore";
import { processShellHistoryOsc } from "./shellHistoryOsc";
import {
  SHELL_HISTORY_SYNC_BEGIN,
  SHELL_HISTORY_SYNC_END,
  decodeShellHistoryOscPayload,
  finishSilentHistorySync,
  isSilentHistorySync,
} from "./shellHistorySync";
import { stripShellHistorySyncNoise } from "./shellHistoryOutputFilter";

const textBuffers = new Map<string, string>();

function sanitizeBase64Payload(raw: string): string {
  const stripped = stripTerminalControlSequences(raw);
  return stripped.replace(/\s+/g, "").replace(/[^A-Za-z0-9+/=]/g, "");
}

function decodeHistoryBlob(b64: string): string {
  const compact = sanitizeBase64Payload(b64);
  if (!compact) return "";
  return decodeShellHistoryOscPayload(compact);
}

function applyHistoryLines(sessionId: string, lines: string[]) {
  if (lines.length === 0) return;
  const commands = normalizeHistoryCommands([...lines].reverse());
  if (commands.length === 0) return;
  useSessionShellHistoryStore.getState().setCommands(sessionId, commands);
  invalidateSessionHistoryIndex(sessionId);
}

function tryFinalizeTextSync(sessionId: string, buffer: string): boolean {
  const beginIdx = buffer.indexOf(SHELL_HISTORY_SYNC_BEGIN);
  const endIdx = buffer.indexOf(SHELL_HISTORY_SYNC_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) return false;

  const payload = buffer.slice(beginIdx + SHELL_HISTORY_SYNC_BEGIN.length, endIdx);
  const decoded = decodeHistoryBlob(payload);
  if (decoded) {
    const lines = decoded.split(/\n/).map((line) => line.trim()).filter(Boolean);
    applyHistoryLines(sessionId, lines);
  }

  textBuffers.delete(sessionId);
  if (isSilentHistorySync(sessionId)) {
    finishSilentHistorySync(sessionId);
  }
  return true;
}

function shouldTrackTextSync(sessionId: string, text: string): boolean {
  return (
    isSilentHistorySync(sessionId) ||
    textBuffers.has(sessionId) ||
    text.includes(SHELL_HISTORY_SYNC_BEGIN) ||
    text.includes(SHELL_HISTORY_SYNC_END)
  );
}

function ingestTextSync(sessionId: string, text: string): boolean {
  const prev = textBuffers.get(sessionId) ?? "";
  const buffer = prev + text;
  textBuffers.set(sessionId, buffer.length > 2_000_000 ? buffer.slice(-2_000_000) : buffer);
  return tryFinalizeTextSync(sessionId, textBuffers.get(sessionId) ?? buffer);
}

/** 解析 shell 历史同步输出（文本标记 + OSC），静默期吞掉回显 */
export function ingestTerminalHistoryOutput(sessionId: string, rawText: string): string {
  if (shouldTrackTextSync(sessionId, rawText)) {
    ingestTextSync(sessionId, rawText);
  }

  if (isSilentHistorySync(sessionId)) {
    processShellHistoryOsc(sessionId, rawText);
    return "";
  }

  const oscCleaned = processShellHistoryOsc(sessionId, rawText);
  return stripShellHistorySyncNoise(oscCleaned);
}

export function resetTerminalHistoryIngest(sessionId: string): void {
  textBuffers.delete(sessionId);
}
