import { useCallback, useEffect, useState } from "react";
import { RefreshCwIcon, RotateCcwIcon } from "lucide-react";

import { fetchDebugStatus, resetDebugSession, type DebugStatus } from "./api";
import { DebugRuntimeProvider } from "./DebugRuntimeProvider";
import { DebugThread } from "./DebugThread";

export function App() {
  const [status, setStatus] = useState<DebugStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [sessionKey, setSessionKey] = useState(0);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await fetchDebugStatus();
      setStatus(next);
      setStatusError(null);
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 5000);
    return () => window.clearInterval(timer);
  }, [refreshStatus]);

  const handleResetSession = async () => {
    await resetDebugSession();
    setSessionKey((key) => key + 1);
    await refreshStatus();
  };

  return (
    <div className="debug-app">
      <header className="debug-header">
        <div>
          <h1>OmniAgent Debug</h1>
          <p className="debug-header__subtitle">web 模式 · assistant-ui 客户端</p>
        </div>
        <div className="debug-header__actions">
          <button type="button" className="debug-btn" onClick={() => void refreshStatus()}>
            <RefreshCwIcon size={14} />
            刷新状态
          </button>
          <button type="button" className="debug-btn" onClick={() => void handleResetSession()}>
            <RotateCcwIcon size={14} />
            重置会话
          </button>
        </div>
      </header>

      <aside className="debug-status">
        {statusError ? (
          <p className="debug-status__error">无法连接调试服务：{statusError}</p>
        ) : status ? (
          <>
            <div className="debug-status__row">
              <span>模式</span>
              <strong>{status.mode ?? "web"}</strong>
            </div>
            <div className="debug-status__row">
              <span>配置</span>
              <strong className={status.configured ? "ok" : "warn"}>
                {status.configured ? "已加载" : "未配置"}
              </strong>
            </div>
            <div className="debug-status__row">
              <span>模型</span>
              <strong>{status.model ?? "—"}</strong>
            </div>
            <div className="debug-status__row">
              <span>MCP</span>
              <strong>{status.mcpCount} 个</strong>
            </div>
            <div className="debug-status__row">
              <span>工作目录</span>
              <code>{status.cwd}</code>
            </div>
            {status.skillsDirs.length > 0 ? (
              <div className="debug-status__skills">
                <span>Skills</span>
                <ul>
                  {status.skillsDirs.map((dir) => (
                    <li key={dir}>
                      <code>{dir}</code>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        ) : (
          <p>加载状态中…</p>
        )}
      </aside>

      <main className="debug-main">
        <DebugRuntimeProvider key={sessionKey}>
          <DebugThread />
        </DebugRuntimeProvider>
      </main>
    </div>
  );
}
