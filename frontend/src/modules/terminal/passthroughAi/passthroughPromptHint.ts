/** 直通模式空提示符处的灰色占位提醒（xterm decoration，不进 PTY） */

import type { IDecoration, IDisposable, IMarker, Terminal } from "@xterm/xterm";

import { createTranslator } from "../../../i18n";
import { useSettingsStore } from "../../../stores/settingsStore";
import { getXterm } from "../xtermRegistry";
import { useShellAgentStore } from "../shellAgent/shellAgentStore";
import { canInterceptEnterForAi, getEnterGateFlags } from "./enterGates";
import { readActiveTerminalLine, stripShellPromptPrefix } from "./screenLine";

type HintState = {
  marker: IMarker;
  decoration: IDecoration;
  renderDisposable: IDisposable | null;
  cursorX: number;
  text: string;
};

const bySession = new Map<string, HintState>();
const rafPending = new Map<string, number>();

function resolveHintText(): string {
  const t = createTranslator(useSettingsStore.getState().locale);
  return t("terminal.passthroughPromptHint");
}

export function clearPassthroughPromptHint(sessionId: string): void {
  const raf = rafPending.get(sessionId);
  if (raf != null) {
    cancelAnimationFrame(raf);
    rafPending.delete(sessionId);
  }
  const cur = bySession.get(sessionId);
  if (!cur) return;
  try {
    cur.renderDisposable?.dispose();
  } catch {
    // ignore
  }
  try {
    cur.decoration.dispose();
  } catch {
    // ignore
  }
  try {
    if (!cur.marker.isDisposed) cur.marker.dispose();
  } catch {
    // ignore
  }
  bySession.delete(sessionId);
}

function paintHint(sessionId: string, term: Terminal, text: string): void {
  const cursorX = term.buffer.active.cursorX;
  const existing = bySession.get(sessionId);
  if (
    existing &&
    !existing.marker.isDisposed &&
    existing.cursorX === cursorX &&
    existing.text === text
  ) {
    return;
  }

  clearPassthroughPromptHint(sessionId);

  let marker: IMarker | undefined;
  try {
    marker = term.registerMarker(0) ?? undefined;
  } catch {
    return;
  }
  if (!marker || marker.isDisposed) return;

  const remaining = Math.max(1, term.cols - cursorX);
  const width = Math.min(Math.max(text.length, 1), remaining);
  let decoration: IDecoration | undefined;
  try {
    decoration =
      term.registerDecoration({
        marker,
        x: cursorX,
        width,
        height: 1,
      }) ?? undefined;
  } catch {
    try {
      marker.dispose();
    } catch {
      // ignore
    }
    return;
  }
  if (!decoration) {
    try {
      marker.dispose();
    } catch {
      // ignore
    }
    return;
  }

  const renderDisposable = decoration.onRender((element) => {
    element.className = "term-passthrough-prompt-hint";
    element.textContent = text;
  });

  bySession.set(sessionId, {
    marker,
    decoration,
    renderDisposable,
    cursorX,
    text,
  });
}

/**
 * 按当前会话状态刷新灰色提醒：直通 + 空行 + 可拦截 Enter（主提示符）时显示。
 * @param enabled 当前是否直通模式
 * @param lineEmpty 行缓冲是否为空（可靠时）
 */
export function syncPassthroughPromptHint(
  sessionId: string,
  opts: { enabled: boolean; lineEmpty: boolean },
): void {
  const text = resolveHintText();
  const gates = getEnterGateFlags(sessionId);
  const busy = useShellAgentStore.getState().isBusy(sessionId);
  const show =
    opts.enabled &&
    opts.lineEmpty &&
    text.length > 0 &&
    !busy &&
    canInterceptEnterForAi(gates);

  if (!show) {
    clearPassthroughPromptHint(sessionId);
    return;
  }

  const term = getXterm(sessionId);
  if (!term) {
    clearPassthroughPromptHint(sessionId);
    return;
  }

  const body = stripShellPromptPrefix(readActiveTerminalLine(term)).trim();
  if (body.length > 0) {
    clearPassthroughPromptHint(sessionId);
    return;
  }

  paintHint(sessionId, term, text);
}

/** 合并同帧多次同步（输出批量 / 打字） */
export function schedulePassthroughPromptHintSync(
  sessionId: string,
  opts: { enabled: boolean; lineEmpty: boolean },
): void {
  const prev = rafPending.get(sessionId);
  if (prev != null) cancelAnimationFrame(prev);
  const id = requestAnimationFrame(() => {
    rafPending.delete(sessionId);
    syncPassthroughPromptHint(sessionId, opts);
  });
  rafPending.set(sessionId, id);
}
