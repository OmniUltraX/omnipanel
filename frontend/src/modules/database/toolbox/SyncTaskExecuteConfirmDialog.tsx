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

  useEffect(() => {
    if (!open || !input) {
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
  }, [open, input]);

  const previewStatus: ContentPreviewStatus = loading
    ? "loading"
    : error
      ? "error"
      : sql.trim()
        ? "ready"
        : "empty";

  const previewContent: ContentPreviewPayload | undefined = useMemo(
    () => (sql.trim() ? { kind: "text", text: sql } : undefined),
    [sql],
  );

  const previewResetKey = useMemo(
    () => (input ? `${input.tab}:${input.tableNames.join("\0")}` : ""),
    [input],
  );

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
            disabled={loading || Boolean(error) || confirming || !sql.trim()}
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
