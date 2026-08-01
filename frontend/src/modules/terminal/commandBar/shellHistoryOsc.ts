import { normalizeHistoryCommands } from "./internalHistoryCommands";
import { useSessionShellHistoryStore } from "./sessionShellHistoryStore";
import {
  decodeShellHistoryOscPayload,
  finishSilentHistorySync,
  isSilentHistorySync,
} from "./shellHistorySync";
import { invalidateSessionHistoryIndex } from "./historyIndexCache";

const OSC_1337_RE = /\x1b\]1337;([^\x07]+)\x07/g;

const streamCarry = new Map<string, string>();
const blobParts = new Map<string, string[]>();
const pendingLines = new Map<string, string[]>();

/**
 * 检查 OSC 序列是否完整（以 `\x1b]` 开头，包含 BEL `\x07` 或 ST `\x1b\\` 结尾）。
 *
 * 用于跨 chunk carry 判断：不完整的 OSC 不能交给 stripTerminalControlSequences
 * 正则处理（会因缺少结尾而漏匹配，导致 `]7;file://host/path` 等内容泄漏显示）。
 */
function isOscComplete(text: string): boolean {
  if (text.length < 3) return false;
  const body = text.slice(2); // 跳过 \x1b]
  if (body.includes("\x07")) return true; // BEL 结尾
  if (body.includes("\x1b\\")) return true; // ST 结尾
  return false;
}

function decodeHistoryBlob(b64: string): string {
  try {
    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

function flushShellHistory(sessionId: string) {
  const pending = pendingLines.get(sessionId) ?? [];
  pendingLines.delete(sessionId);
  if (pending.length > 0) {
    const commands = normalizeHistoryCommands([...pending].reverse());
    useSessionShellHistoryStore.getState().setCommands(sessionId, commands);
    invalidateSessionHistoryIndex(sessionId);
  }
  finishSilentHistorySync(sessionId);
}

function handleOscPayload(sessionId: string, payload: string) {
  if (payload.startsWith("HistoryPart=")) {
    const parts = blobParts.get(sessionId) ?? [];
    parts.push(payload.slice("HistoryPart=".length));
    blobParts.set(sessionId, parts);
    return;
  }

  if (payload === "HistoryBlobEnd") {
    const parts = blobParts.get(sessionId) ?? [];
    blobParts.delete(sessionId);
    if (parts.length > 0) {
      const decoded = decodeHistoryBlob(parts.join(""));
      const lines = decoded.split(/\r?\n/);
      const bucket = pendingLines.get(sessionId) ?? [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) bucket.push(trimmed);
      }
      pendingLines.set(sessionId, bucket);
    }
    flushShellHistory(sessionId);
    return;
  }

  if (payload.startsWith("History=")) {
    const command = decodeShellHistoryOscPayload(payload.slice("History=".length));
    if (!command) return;
    const bucket = pendingLines.get(sessionId) ?? [];
    bucket.push(command);
    pendingLines.set(sessionId, bucket);
    return;
  }

  if (payload === "HistoryDone") {
    flushShellHistory(sessionId);
  }
}

function stripShellHistoryOsc(sessionId: string, text: string): string {
  let carry = streamCarry.get(sessionId) ?? "";
  const input = carry + text;
  streamCarry.set(sessionId, "");

  // 暂存未完成的 OSC 序列（任意 OSC，不只是 1337）。
  // OSC 以 \x1b] 开头，以 \x07 (BEL) 或 \x1b\\ (ST) 结尾。
  // 跨 chunk 拆分时如果不暂存，不完整的 OSC 会被 stripTerminalControlSequences
  // 正则漏匹配（因缺少结尾），导致 ]7;file://host/path 等内容作为文本泄漏显示。
  //
  // 注意：不能只检查 \x1b]1337; —— OSC 7 (cwd 上报)、OSC 0 (标题) 等序列
  // 也会跨 chunk，同样需要暂存。
  const oscStart = input.lastIndexOf("\x1b]");
  let processable = input;
  if (oscStart !== -1) {
    const tail = input.slice(oscStart);
    if (!isOscComplete(tail)) {
      streamCarry.set(sessionId, tail);
      processable = input.slice(0, oscStart);
    }
  }

  if (!processable.includes("\x1b]1337;")) {
    return processable;
  }

  let cleaned = "";
  let lastIndex = 0;
  for (const match of processable.matchAll(OSC_1337_RE)) {
    const index = match.index ?? 0;
    cleaned += processable.slice(lastIndex, index);
    lastIndex = index + match[0].length;
    const payload = match[1] ?? "";
    if (
      payload.startsWith("History") ||
      payload === "HistoryBlobEnd" ||
      payload === "HistoryDone"
    ) {
      handleOscPayload(sessionId, payload);
    }
  }
  cleaned += processable.slice(lastIndex);
  return cleaned;
}

/** 从 PTY 原始输出解析 Shell 历史 OSC（支持分片与 Blob 批量传输） */
export function processShellHistoryOsc(sessionId: string, text: string): string {
  // 检测任意 OSC（\x1b]）而非仅 1337——OSC 7/0 等跨 chunk 时也需要 carry 处理，
  // 否则不完整的 OSC 会泄漏到 stripTerminalControlSequences 之后的文本中。
  if (!text.includes("\x1b]") && !streamCarry.has(sessionId)) {
    return text;
  }

  const cleaned = stripShellHistoryOsc(sessionId, text);
  if (isSilentHistorySync(sessionId) && cleaned.trim().length === 0) {
    return "";
  }
  return cleaned;
}

export function resetShellHistoryOsc(sessionId: string): void {
  streamCarry.delete(sessionId);
  blobParts.delete(sessionId);
  pendingLines.delete(sessionId);
}
