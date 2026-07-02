import { useEffect, useState } from "react";
import { DataLoading } from "../../../components/ui/DataLoading";
import { TableDdlViewer } from "../table/TableDdlViewer";
import { buildSyncTaskSqlPreview, type SyncTaskSqlPreviewInput } from "./syncTaskSqlPreview";

interface SyncTaskScriptPreviewPanelProps {
  input: SyncTaskSqlPreviewInput | null;
}

export function SyncTaskScriptPreviewPanel({ input }: SyncTaskScriptPreviewPanelProps) {
  const [sql, setSql] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!input) {
      setSql("");
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    void buildSyncTaskSqlPreview(input)
      .then((text) => {
        if (!cancelled) {
          setSql(text);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(String(e));
          setSql("");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [input]);

  if (!input) {
    return null;
  }

  if (loading) {
    return (
      <div className="db-sync-script-preview">
        <DataLoading total={1} current={0} message="" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="db-sync-script-preview">
        <p className="db-sync-script-preview__error">{error}</p>
      </div>
    );
  }

  return (
    <div className="db-sync-script-preview">
      <TableDdlViewer ddl={sql} />
    </div>
  );
}
