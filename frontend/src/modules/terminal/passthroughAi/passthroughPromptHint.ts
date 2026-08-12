/** 直通模式空提示符处的灰色占位提醒（xterm decoration，不进 PTY） */

import type { IDecoration, IDisposable, IMarker, Terminal } from "@xterm/xterm";

import { createTranslator } from "../../../i18n";
import { useSettingsStore } from "../../../stores/settingsStore";
import { getXterm } from "../xtermRegistry";
import { useShellAgentStore } from "../shellAgent/shellAgentStore";
import { canInterceptEnterForAi, getEnterGateFlags } from "./enterGates";
import {
  lineLooksLikeShellPrompt,
  readActiveTerminalLine,
} from "./screenLine";

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

  // 装饰宽度按终端列（CJK 约占 2 列），避免被裁成看不见
  let textCols = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    textCols += cp > 0xff ? 2 : 1;
  }
  const remaining = Math.max(1, term.cols - cursorX);
  const width = Math.min(Math.max(textCols, 1), remaining);
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
    // 勿覆盖 className：xterm 用自带 class 定位，冲掉会漂到左上角
    element.classList.add("term-passthrough-prompt-hint");
    element.textContent = text;
    // xterm 内联写入 line-height=cellHeight，相对同行列 prompt 字形会略偏上；
    // 实测 +2px 与 shell prompt 基线对齐（CSS 压不过内联，须在 onRender 覆盖）
    const cellH =
      parseFloat(element.style.height) ||
      element.offsetHeight ||
      0;
    if (cellH > 0) {
      // 实测 height+2（24→26）与 PS/ bash prompt 基线对齐
      element.style.lineHeight = `${cellH + 2}px`;
    }
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
 * 按当前会话状态刷新灰色提醒：
 * 直通 + 空行缓冲 + 可拦截 Enter + **当前行已有 shell 主提示符**时显示。
 * 空终端 / 尚未出 prompt（光标在左上角）不显示，避免漂在空白区。
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
    !gates.imeComposing &&
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

  const screenLine = readActiveTerminalLine(term);
  // 必须已有真实空提示符（如 root@host:~#）；# 后无空格也算
  if (!lineLooksLikeShellPrompt(screenLine)) {
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
