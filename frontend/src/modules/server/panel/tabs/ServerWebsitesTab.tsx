import { useEffect, useRef } from "react";
import { useI18n } from "../../../../i18n";
import { Button } from "../../../../components/ui/primitives/Button";
import type { ServerEntry } from "../serverConnection";
import { useServerWebsites } from "../useServerWebsites";
import { websiteRowId, websiteRowLabel } from "../serverResourceLabels";

interface Props {
  server: ServerEntry;
  selectedItemId?: string;
}

function rowStatus(row: Record<string, unknown>): string {
  return String(row.status ?? row.appStatus ?? "—");
}

export function ServerWebsitesTab({ server, selectedItemId }: Props) {
  const { t } = useI18n();
  const { items: rows, loading, error, refresh } = useServerWebsites(server);
  const selectedRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!selectedItemId) return;
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedItemId, rows.length]);

  return (
    <div className="server-panel-tab">
      <div className="server-panel-tab-toolbar">
        <span className="server-panel-tab-title">{t("server.tabs.websites")}</span>
        <Button variant="ghost" size="sm" disabled={loading} onClick={() => void refresh()}>
          {loading ? t("server.refreshing") : t("server.refresh")}
        </Button>
      </div>
      {error && <div className="server-apps-error">{error}</div>}
      <div className="server-resource-list">
        {loading && rows.length === 0 ? (
          <div className="server-apps-empty">{t("server.refreshing")}</div>
        ) : null}
        {rows.map((row, idx) => {
          const rowId = websiteRowId(row, idx);
          const active = selectedItemId === rowId;
          return (
            <div
              key={rowId}
              ref={active ? selectedRef : undefined}
              className={`server-resource-item${active ? " server-resource-item--active" : ""}`}
            >
              <div className="server-resource-item__main">
                <strong>{websiteRowLabel(row)}</strong>
                <span className="text-muted text-sm">{String(row.path ?? row.ps ?? "")}</span>
              </div>
              <span className="badge badge-muted">{rowStatus(row)}</span>
            </div>
          );
        })}
        {!loading && rows.length === 0 && !error && (
          <div className="server-apps-empty">{t("server.websites.empty")}</div>
        )}
      </div>
    </div>
  );
}
