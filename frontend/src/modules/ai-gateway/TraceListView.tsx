import { useEffect, useState } from "react";

import { commands, type AiSessionRecord } from "../../ipc/bindings";
import { canUseIpcBackend } from "../../lib/isTauriRuntime";
import { useI18n } from "../../i18n";
import { TraceDetailView } from "./TraceDetailView";

const SOURCES = ["internal", "gateway", "mcp_external"] as const;

export function TraceListView() {
  const { t } = useI18n();
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

  const sourceLabel = (id: (typeof SOURCES)[number]) => {
    if (id === "internal") return t("settings.aiServices.traces.sourceInternal");
    if (id === "gateway") return t("settings.aiServices.traces.sourceGateway");
    return t("settings.aiServices.traces.sourceMcpExternal");
  };

  return (
    <div className="ai-trace-layout">
      <div className="ai-trace-sources">
        {SOURCES.map((item) => (
          <button
            key={item}
            type="button"
            className={`settings-tab${source === item ? " is-active" : ""}`}
            onClick={() => {
              setSource(item);
              setSelectedId(null);
            }}
          >
            {sourceLabel(item)}
          </button>
        ))}
      </div>

      <div className="ai-trace-split">
        <ul className="ai-trace-session-list">
          {loading ? <li className="section-desc">{t("settings.aiServices.traces.loading")}</li> : null}
          {!loading && sessions.length === 0 ? (
            <li className="section-desc">{t("settings.aiServices.traces.empty")}</li>
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
