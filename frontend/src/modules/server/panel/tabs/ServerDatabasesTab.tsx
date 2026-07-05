import { useEffect, useState } from "react";
import { useI18n } from "../../../../i18n";
import { Button } from "../../../../components/ui/primitives/Button";
import type { ServerEntry } from "../serverConnection";
import { createOnePanelClient } from "../../../../lib/onepanel";
import { createBtPanelClient } from "../../../../lib/btpanel";

interface Props {
  server: ServerEntry;
}

export function ServerDatabasesTab({ server }: Props) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      if (server.serviceType === "1panel") {
        const client = createOnePanelClient(server.address, server.key);
        const items = await client.searchDatabases();
        setRows(items as Record<string, unknown>[]);
      } else {
        const client = createBtPanelClient(server.address, server.key);
        const result = await client.getDatabaseList({ limit: 100 });
        setRows(result.data);
      }
    } catch (e) {
      setError(String(e));
      setRows([]);
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
        <span className="server-panel-tab-title">{t("server.tabs.databases")}</span>
        <Button variant="ghost" size="sm" disabled={loading} onClick={() => void load()}>
          {loading ? t("server.refreshing") : t("server.refresh")}
        </Button>
      </div>
      {error && <div className="server-apps-error">{error}</div>}
      <div className="server-resource-list">
        {rows.map((row, idx) => (
          <div key={String(row.id ?? idx)} className="server-resource-item">
            <div className="server-resource-item__main">
              <strong>{String(row.name ?? row.database ?? row.dbName ?? "—")}</strong>
              <span className="text-muted text-sm">{String(row.type ?? row.dbType ?? row.ps ?? "")}</span>
            </div>
            <span className="badge badge-muted">{String(row.status ?? "—")}</span>
          </div>
        ))}
        {!loading && rows.length === 0 && !error && (
          <div className="server-apps-empty">{t("server.databases.empty")}</div>
        )}
      </div>
    </div>
  );
}
