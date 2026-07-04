/** 终端面板命令发送器（按 tabId 索引，模块内与底部工作区镜像共享） */
export const terminalPaneSenders: Record<string, (cmd: string) => void> = {};

/** 原始 PTY 写入（Ctrl+C、换行等），与 sendCommand 的「命令+回车」区分 */
export const terminalPaneRawWriters: Record<string, (data: string) => void> = {};

export function setTerminalPaneSender(
  tabId: string,
  sender: ((cmd: string) => void) | null,
): void {
  if (sender) {
    terminalPaneSenders[tabId] = sender;
  } else {
    delete terminalPaneSenders[tabId];
  }
}

export function setTerminalPaneRawWriter(
  tabId: string,
  writer: ((data: string) => void) | null,
): void {
  if (writer) {
    terminalPaneRawWriters[tabId] = writer;
  } else {
    delete terminalPaneRawWriters[tabId];
  }
}

export function writeTerminalRaw(sessionId: string, data: string): boolean {
  const writer = terminalPaneRawWriters[sessionId];
  if (!writer) return false;
  writer(data);
  return true;
}

export function hasTerminalRawWriter(sessionId: string): boolean {
  return Boolean(terminalPaneRawWriters[sessionId]);
}

export function clearTerminalPaneSender(tabId: string): void {
  delete terminalPaneSenders[tabId];
  delete terminalPaneRawWriters[tabId];
}
