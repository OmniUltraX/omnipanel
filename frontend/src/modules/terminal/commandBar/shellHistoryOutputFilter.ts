import {
  isSilentHistorySyncCommand,
  SHELL_HISTORY_SYNC_BEGIN,
  SHELL_HISTORY_SYNC_END,
} from "./shellHistorySync";

/** 终端输出/快照中是否含历史同步脚本或标记 */
export function containsShellHistorySyncNoise(text: string): boolean {
  if (!text) return false;
  if (text.includes(SHELL_HISTORY_SYNC_BEGIN) || text.includes(SHELL_HISTORY_SYNC_END)) {
    return true;
  }
  if (isSilentHistorySyncCommand(text)) return true;
  return /__OMNIPANEL_HIST_|HistorySavePath|Get-PSReadLineOption|HistoryBlobEnd|HistoryPart=/.test(
    text,
  );
}

/** 从可见终端文本中剔除历史同步脚本行与标记行 */
export function stripShellHistorySyncNoise(text: string): string {
  if (!text || !containsShellHistorySyncNoise(text)) return text;

  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  let skippingMultiline = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (!skippingMultiline) kept.push(line);
      continue;
    }

    if (
      trimmed.includes(SHELL_HISTORY_SYNC_BEGIN) ||
      trimmed.includes(SHELL_HISTORY_SYNC_END) ||
      isSilentHistorySyncCommand(trimmed)
    ) {
      skippingMultiline = !trimmed.includes(SHELL_HISTORY_SYNC_END);
      continue;
    }

    if (skippingMultiline) {
      if (/^[A-Za-z0-9+/=]{40,}$/.test(trimmed)) continue;
      if (trimmed.includes(SHELL_HISTORY_SYNC_END)) {
        skippingMultiline = false;
      }
      continue;
    }

    if (/^PS\s/.test(trimmed) && trimmed.includes("__OMNIPANEL_HIST_")) continue;
    kept.push(line);
  }

  return kept.join("\n");
}

/** 跨 chunk 记住某会话是否正处于 BEGIN→END 之间 */
const sessionSkippingSync = new Map<string, boolean>();

const HIST_MARKER_BYTES = new TextEncoder().encode("__OMNIPANEL_HIST_");

function bytesContainHistMarker(bytes: Uint8Array): boolean {
  if (bytes.length < HIST_MARKER_BYTES.length) return false;
  outer: for (let i = 0; i <= bytes.length - HIST_MARKER_BYTES.length; i += 1) {
    for (let j = 0; j < HIST_MARKER_BYTES.length; j += 1) {
      if (bytes[i + j] !== HIST_MARKER_BYTES[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * 带会话状态的剔除：BEGIN/END 可能跨多个 PTY chunk 到达，
 * 且超时应后迟到的标记仍需丢掉，不能只在 isSilentHistorySync 期间过滤。
 */
export function stripShellHistorySyncNoiseStateful(sessionId: string, text: string): string {
  if (!text && !sessionSkippingSync.get(sessionId)) return text;

  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  let skipping = sessionSkippingSync.get(sessionId) === true;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.includes(SHELL_HISTORY_SYNC_BEGIN)) {
      skipping = !trimmed.includes(SHELL_HISTORY_SYNC_END);
      continue;
    }
    if (trimmed.includes(SHELL_HISTORY_SYNC_END)) {
      skipping = false;
      continue;
    }
    if (skipping) {
      continue;
    }
    if (!trimmed) {
      kept.push(line);
      continue;
    }
    if (isSilentHistorySyncCommand(trimmed) || /__OMNIPANEL_HIST_/.test(trimmed)) {
      continue;
    }
    kept.push(line);
  }

  if (skipping) sessionSkippingSync.set(sessionId, true);
  else sessionSkippingSync.delete(sessionId);

  return kept.join("\n");
}

export function resetShellHistorySyncFilterState(sessionId?: string): void {
  if (sessionId) sessionSkippingSync.delete(sessionId);
  else sessionSkippingSync.clear();
}

/** 将 PTY 字节写入 xterm 前去掉历史同步噪声；无噪声时原样返回以免拆开 UTF-8。 */
export function preparePtyBytesForXterm(sessionId: string, bytes: Uint8Array): Uint8Array {
  if (!sessionId || bytes.length === 0) return bytes;
  if (!sessionSkippingSync.get(sessionId) && !bytesContainHistMarker(bytes)) {
    return bytes;
  }
  const raw = new TextDecoder().decode(bytes);
  const cleaned = stripShellHistorySyncNoiseStateful(sessionId, raw);
  if (cleaned === raw) return bytes;
  return new TextEncoder().encode(cleaned);
}
