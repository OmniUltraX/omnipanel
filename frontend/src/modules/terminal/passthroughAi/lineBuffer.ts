/** 直通智能 Enter：命令行镜像缓冲（保守估算，不确定时由闸门 fail-open） */

export type LineBufferState = {
  text: string;
  /** 缓冲是否因复杂重绘变得不可信 */
  reliable: boolean;
};

export function createLineBuffer(): LineBufferState {
  return { text: "", reliable: true };
}

/** 处理发往 PTY 的用户输入字节，更新行缓冲 */
export function applyUserDataToLineBuffer(
  state: LineBufferState,
  data: string,
): LineBufferState {
  if (!data) return state;

  let text = state.text;
  let reliable = state.reliable;

  for (const ch of data) {
    const code = ch.charCodeAt(0);
    if (ch === "\r" || ch === "\n") {
      text = "";
      continue;
    }
    // Ctrl+U
    if (code === 0x15) {
      text = "";
      continue;
    }
    // Ctrl+C / Ctrl+G — 取消当前行
    if (code === 0x03 || code === 0x07) {
      text = "";
      continue;
    }
    // Ctrl+W 删词
    if (code === 0x17) {
      text = text.replace(/\s*\S*$/, "");
      continue;
    }
    // Backspace / DEL
    if (code === 0x7f || code === 0x08) {
      text = text.slice(0, -1);
      continue;
    }
    // 其它控制字符：标为不可信，但不清空（Tab 补全等会重绘）
    if (code < 0x20) {
      reliable = false;
      continue;
    }
    text += ch;
  }

  return { text, reliable };
}

export function resetLineBuffer(state: LineBufferState): LineBufferState {
  return { ...state, text: "", reliable: true };
}

export function markLineBufferUnreliable(state: LineBufferState): LineBufferState {
  return { ...state, reliable: false };
}
