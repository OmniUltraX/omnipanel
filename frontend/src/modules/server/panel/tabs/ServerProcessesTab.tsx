import { useEffect, useState } from "react";
import { useI18n } from "../../../../i18n";
import { Button } from "../../../../components/ui/primitives/Button";
import type { ServerEntry } from "../serverConnection";
import { createOnePanelClient } from "../../../../lib/onepanel";
import type { OnePanelProcess } from "../../../../lib/onepanel/types";

interface Props {
  server: ServerEntry;
}

function formatProcessMemory(bytes?: number): string {
  if (!bytes) return "—";
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export function ServerProcessesTab({ server }: Props) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [processes, setProcesses] = useState<OnePanelProcess[]>([]);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      if (server.serviceType !== "1panel") {
        setProcesses([]);
        setError(t("server.processes.unsupported"));
        return;
      }
      const client = createOnePanelClient(server.address, server.key);
      const list = await client.getTopProcesses("cpu");
      setProcesses(list);
    } catch (e) {
      setError(String(e));
      setProcesses([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [server.id]);

  return (
    <div className="server-panel-tab">
      <div className="server-panel-tab-toolbar">
        <span className="server-panel-tab-title">{t("server.tabs.processes")}</span>
        <Button variant="ghost" size="sm" disabled={loading} onClick={() => void load()}>
          {loading ? t("server.refreshing") : t("server.refresh")}
        </Button>
      </div>
      {error && <div className="server-apps-error">{error}</div>}
      <div className="server-resource-table-wrap">
        <table className="server-resource-table">
          <thead>
            <tr>
              <th>PID</th>
              <th>{t("server.processes.name")}</th>
              <th>CPU</th>
              <th>{t("server.processes.memory")}</th>
              <th>{t("server.processes.user")}</th>
            </tr>
          </thead>
          <tbody>
            {processes.map((p) => (
              <tr key={p.pid}>
                <td>{p.pid}</td>
                <td>{p.name}</td>
                <td>{(p.percent ?? p.cpuPercent ?? 0).toFixed(1)}%</td>
                <td>{p.memoryPercent != null ? `${p.memoryPercent.toFixed(1)}%` : formatProcessMemory(p.memory)}</td>
                <td>{p.user ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && processes.length === 0 && !error && (
          <div className="server-apps-empty">{t("server.processes.empty")}</div>
        )}
      </div>
    </div>
  );
}
