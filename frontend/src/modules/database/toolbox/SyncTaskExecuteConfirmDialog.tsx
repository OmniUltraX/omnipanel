import { useEffect, useMemo, useState } from "react";
import { ContentPreviewView } from "../../../components/ui/ContentPreviewView";
import { Button } from "../../../components/ui/primitives/Button";
import { SubWindow } from "../../../components/ui/SubWindow";
import type { ContentPreviewPayload, ContentPreviewStatus } from "../../../lib/contentPreview";
import { useI18n } from "../../../i18n";
import { buildSyncTaskSqlPreview, type SyncTaskSqlPreviewInput } from "./syncTaskSqlPreview";

interface SyncTaskExecuteConfirmDialogProps {
  open: boolean;
  title: string;
  input: SyncTaskSqlPreviewInput | null;
  confirming?: boolean;
  onClose: () => void;
  onConfirm: () => void;
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
      ...input.tableNames.map(
        (name) =>
          `${name}|${input.tableSyncStrategies[name] ?? ""}|${input.tableTargetStatus[name] ?? ""}`,
      ),
    ].join("\n");
  }, [input]);

  useEffect(() => {
    if (!open || !input || !previewInputKey) {
      setSql("");
      setError(null);
      setLoading(false);
      setPreviewResolved(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setPreviewResolved(false);

    void buildSyncTaskSqlPreview(input)
      .then((text) => {
        if (!cancelled) {
          setSql(text);
          setPreviewResolved(true);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(String(e));
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
    };
  }, [open, input, previewInputKey]);

  const previewStatus: ContentPreviewStatus = loading
    ? "loading"
    : error
      ? "error"
      : previewResolved
        ? "ready"
        : "empty";

  const previewContent: ContentPreviewPayload | undefined = useMemo(
    () => (previewResolved ? { kind: "text", text: sql } : undefined),
    [previewResolved, sql],
  );

  const previewResetKey = previewInputKey;

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
        <p className="db-sync-execute-confirm__hint">{t("database.toolbox.executeConfirmHint")}</p>
        <div className="db-sync-execute-confirm__preview">
          <ContentPreviewView
            status={previewStatus}
            content={previewContent}
            errorMessage={error ?? undefined}
            loadingMessage={t("database.toolbox.executeConfirmLoading")}
            codeLanguage="sql"
            defaultTextMode="code"
            contentResetKey={previewResetKey}
            className="content-preview-view--embedded"
          />
        </div>
        <div className="db-sync-execute-confirm__actions">
          <Button type="button" variant="ghost" onClick={onClose} disabled={confirming}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            variant="default"
            onClick={onConfirm}
            disabled={loading || Boolean(error) || confirming || !previewResolved}
          >
            {confirming
              ? t("database.toolbox.executeConfirmRunning")
              : t("database.toolbox.executeConfirmRun")}
          </Button>
        </div>
      </div>
    </SubWindow>
  );
}
