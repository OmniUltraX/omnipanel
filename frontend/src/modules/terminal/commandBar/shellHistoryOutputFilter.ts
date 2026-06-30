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
