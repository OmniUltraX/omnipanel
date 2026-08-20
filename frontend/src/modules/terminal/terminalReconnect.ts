import {
  clearPaneBackendPending,
  disposeSessionBackend,
} from "../../hooks/useTerminal";
import { useTerminalStore } from "../../stores/terminalStore";
import { clearTerminalPaneSender } from "./terminalPaneSenders";

/**
 * 重建后端 PTY，保留当前直通或命令栏模式。
 * 手动重连请先 cancelAutoReconnectSsh，避免与自动重连抢跑。
 */
export function reconnectTerminalSession(sessionId: string): void {
  clearTerminalPaneSender(sessionId);
  clearPaneBackendPending(sessionId);
  disposeSessionBackend(sessionId, undefined, { preserveInputMode: true });
  const store = useTerminalStore.getState();
  store.setBackendSessionId(sessionId, null);
  store.setStatus(sessionId, "connecting");
  store.bumpReconnect(sessionId);
}
