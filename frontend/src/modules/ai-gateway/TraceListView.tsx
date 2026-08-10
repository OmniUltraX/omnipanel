import { useEffect, useState } from "react";

import { commands, type AiSessionRecord } from "../../ipc/bindings";
import { canUseIpcBackend } from "../../lib/isTauriRuntime";
import { TraceDetailView } from "./TraceDetailView";

const SOURCES = [
  { id: "internal", label: "内置 AI" },
  { id: "gateway", label: "Agent Router" },
  { id: "mcp_external", label: "外部 MCP" },
] as const;

export function TraceListView() {
  const [source, setSource] = useState<string>("internal");
  const [sessions, setSessions] = useState<AiSessionRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!canUseIpcBackend()) return;
    setLoading(true);
    void commands
      .aiListSessions(source)
      .then((res) => {
        if (res.status === "ok") {
          setSessions(res.data);
        } else {
          setSessions([]);
        }
      })
      .catch(() => setSessions([]))
      .finally(() => setLoading(false));
  }, [source]);

  return (
    <div className="ai-trace-layout">
      <div className="ai-trace-sources">
        {SOURCES.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`settings-tab${source === item.id ? " is-active" : ""}`}
            onClick={() => {
              setSource(item.id);
              setSelectedId(null);
            }}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="ai-trace-split">
        <ul className="ai-trace-session-list">
          {loading ? <li className="section-desc">加载中…</li> : null}
          {!loading && sessions.length === 0 ? (
            <li className="section-desc">暂无 session</li>
          ) : null}
          {sessions.map((session) => (
            <li key={session.id}>
              <button
                type="button"
                className={`ai-trace-session-item${selectedId === session.id ? " is-active" : ""}`}
                onClick={() => setSelectedId(session.id)}
              >
                <span>{session.title ?? session.id}</span>
                <span className="section-desc">{session.backendId}</span>
              </button>
            </li>
          ))}
        </ul>
        {selectedId ? <TraceDetailView sessionId={selectedId} /> : null}
      </div>
    </div>
  );
}
