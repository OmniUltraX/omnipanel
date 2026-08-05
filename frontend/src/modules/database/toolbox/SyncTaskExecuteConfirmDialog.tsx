import { useEffect, useMemo, useState } from "react";
import { DataLoading } from "../../../components/ui/feedback/DataLoading";
import { Button } from "../../../components/ui/primitives/Button";
import { SubWindow } from "../../../components/ui/SubWindow";
import { useI18n } from "../../../i18n";
import { TableDdlViewer } from "../table/TableDdlViewer";
import { buildSyncTaskSqlPreview, type SyncTaskSqlPreviewInput } from "./syncTaskSqlPreview";
import { syncExecuteConfirmLog, syncExecuteConfirmWarn } from "./syncExecuteConfirmDebug";
import {
  generateDataSyncSql,
  readDataSyncSqlFile,
  writeDataSyncSqlFile,
} from "./useDbSyncBackgroundTasks";
import { DEFAULT_DATA_SYNC_MODES, normalizeDataSyncModes } from "./types";

interface SyncTaskExecuteConfirmDialogProps {
  open: boolean;
  title: string;
  input: SyncTaskSqlPreviewInput | null;
  confirming?: boolean;
  onClose: () => void;
  /** 确认时传入已保存的可执行 SQL 文件路径 */
  onConfirm: (sqlFilePath: string) => void;
}

function buildDataSyncExecSpecs(input: SyncTaskSqlPreviewInput) {
  return input.tableNames.map((name) => ({
    name,
    columns: input.sourceTableColumns[name] ?? [],
    syncModes: normalizeDataSyncModes(
      input.tableSyncModes[name],
      input.tableTargetStatus[name] === "new"
        ? { insert: true, merge: false, delete: false }
        : DEFAULT_DATA_SYNC_MODES,
    ),
    diffCacheId: input.tableAnalysis?.[name]?.diffCacheId ?? null,
  }));
}

function formatInvokeError(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string") {
      return record.cause ? `${record.message}: ${String(record.cause)}` : record.message;
    }
  }
  return String(error);
}

export function SyncTaskExecuteConfirmDialog({
  open,
  title,
  input,
  confirming = false,
  onClose,
  onConfirm,
}: SyncTaskExecuteConfirmDialogProps) {
  const { t } = useI18n();
  const [sql, setSql] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [previewResolved, setPreviewResolved] = useState(false);

  const previewInputKey = useMemo(() => {
    if (!input) {
      return "";
    }
    return [
      input.tab,
      input.sourceConn.id,
      input.sourceDb,
      input.targetConn.id,
      input.targetDb,
      input.tableNames.join("\0"),
      ...input.tableNames.map((name) => {
        const modes = input.tableSyncModes[name];
        const analysis = input.tableAnalysis?.[name];
        return `${name}|${modes?.insert ? "i" : ""}${modes?.merge ? "m" : ""}${modes?.delete ? "d" : ""}|${input.tableTargetStatus[name] ?? ""}|${analysis?.status ?? ""}|${analysis?.diffCacheId ?? ""}|${analysis?.diffRows ?? ""}`;
      }),
    ].join("\n");
  }, [input]);

  useEffect(() => {
    if (!open || !input || !previewInputKey) {
      syncExecuteConfirmLog("dialog:reset", {
        open,
        hasInput: Boolean(input),
        previewInputKey: previewInputKey || null,
      });
      setSql("");
      setError(null);
      setLoading(false);
      setSaving(false);
      setPreviewResolved(false);
      return;
    }

    let cancelled = false;
    syncExecuteConfirmLog("preview:start", {
      previewInputKey,
      tableNames: input.tableNames,
      tab: input.tab,
    });
    setLoading(true);
    setError(null);
    setPreviewResolved(false);

    const loadPreview = async () => {
      if (input.tab === "dataSync") {
        const missingAnalysis = input.tableNames.filter((name) => {
          const analysis = input.tableAnalysis?.[name];
          return !analysis?.diffCacheId || analysis.status === "analyzing" || analysis.status === "unchecked";
        });
        if (missingAnalysis.length > 0) {
          throw new Error(
            t("database.toolbox.executeConfirmNeedAnalysis", {
              tables: missingAnalysis.join("、"),
            }),
          );
        }
        const result = await generateDataSyncSql(
          input.sourceConn,
          input.targetConn,
          input.sourceDb,
          input.targetDb,
          buildDataSyncExecSpecs(input),
        );
        return readDataSyncSqlFile(result.filePath);
      }
      return buildSyncTaskSqlPreview(input);
    };

    void loadPreview()
      .then((text) => {
        if (!cancelled) {
          syncExecuteConfirmLog("preview:done", {
            previewInputKey,
            textLength: text.length,
            lineCount: text.split("\n").length,
            previewHead: text.slice(0, 320),
          });
          setSql(text);
          setPreviewResolved(true);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          const message = formatInvokeError(e);
          syncExecuteConfirmWarn("preview:error", {
            previewInputKey,
            error: message,
          });
          setError(message);
          setSql("");
          setPreviewResolved(false);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      syncExecuteConfirmLog("preview:cancelled", { previewInputKey });
    };
  }, [open, previewInputKey, input, t]);

  const loadingMessage =
    input?.tab === "dataSync"
      ? t("database.toolbox.executeConfirmGeneratingSql")
      : t("database.toolbox.executeConfirmLoading");

  const hint =
    input?.tab === "dataSync"
      ? t("database.toolbox.executeConfirmHintDataSql")
      : t("database.toolbox.executeConfirmHint");

  const handleConfirm = () => {
    const trimmed = sql.trim();
    if (!trimmed) {
      setError(t("database.toolbox.executeConfirmEmptySql"));
      return;
    }
    setSaving(true);
    setError(null);
    void writeDataSyncSqlFile(sql)
      .then((filePath) => {
        onConfirm(filePath);
      })
      .catch((e) => {
        setError(formatInvokeError(e));
      })
      .finally(() => {
        setSaving(false);
      });
  };

  const busy = loading || saving || confirming;

  return (
    <SubWindow
      open={open}
      title={title}
      onClose={onClose}
      className="db-sync-execute-confirm-subwindow"
      widthRatio={0.72}
      heightRatio={0.72}
    >
      <div className="db-sync-execute-confirm">
        <p className="db-sync-execute-confirm__hint">{hint}</p>
        <div className="db-sync-execute-confirm__preview">
          {loading ? (
            <DataLoading total={1} current={0} message={loadingMessage} />
          ) : error && !previewResolved ? (
            <p className="db-sync-script-preview__error">{error}</p>
          ) : previewResolved ? (
            <TableDdlViewer ddl={sql} readOnly={false} onChange={setSql} />
          ) : null}
        </div>
        {error && previewResolved ? (
          <p className="db-sync-script-preview__error db-sync-execute-confirm__save-error">{error}</p>
        ) : null}
        <div className="db-sync-execute-confirm__actions">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            variant="default"
            onClick={handleConfirm}
            disabled={busy || !previewResolved || !sql.trim()}
          >
            {confirming || saving
              ? t("database.toolbox.executeConfirmRunning")
              : t("database.toolbox.executeConfirmRun")}
          </Button>
        </div>
      </div>
    </SubWindow>
  );
}
