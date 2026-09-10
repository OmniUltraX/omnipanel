/**
 * 打断 `autoReconnectTerminalSsh -> terminalReconnect -> useTerminal -> autoReconnectTerminalSsh` 的环。
 *
 * `disposeSessionBackend` / `clearPaneBackendPending` 的实现住在 `hooks/useTerminal.ts` 里，
 * 而 useTerminal 又要 import autoReconnectTerminalSsh，形成环。把实现搬出来代价太大
 * （`disposeSessionBackend` 依赖 useTerminal 内一批私有状态），所以这里改成依赖注入：
 * useTerminal 在模块加载时注册实现，调用方只依赖本模块。
 *
 * 与 `lib/assistantSnapshotSyncBridge.ts` 是同一套手法。
 */

type ClearPaneBackendPending = (paneId: string) => void;

type DisposeSessionBackend = (
  sessionId: string,
  knownBackendSessionId?: string | null,
  options?: { preserveInputMode?: boolean },
) => void;

let clearPane: ClearPaneBackendPending | null = null;
let disposeBackend: DisposeSessionBackend | null = null;

/** 由 `hooks/useTerminal` 在模块加载时注册实现。 */
export function registerTerminalSessionBackend(fns: {
  clearPaneBackendPending: ClearPaneBackendPending;
  disposeSessionBackend: DisposeSessionBackend;
}): void {
  clearPane = fns.clearPaneBackendPending;
  disposeBackend = fns.disposeSessionBackend;
}

export function clearPaneBackendPending(paneId: string): void {
  clearPane?.(paneId);
}

export function disposeSessionBackend(
  sessionId: string,
  knownBackendSessionId?: string | null,
  options?: { preserveInputMode?: boolean },
): void {
  disposeBackend?.(sessionId, knownBackendSessionId, options);
}
