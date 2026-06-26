import { useEffect, useState } from "react";
import {
  ContentPreviewTextModeToolbar,
  type ContentPreviewTextMode,
} from "../../components/ui/ContentPreviewView";
import { isPreviewWebUrl, normalizePreviewWebUrl } from "../../lib/contentPreview";
import { SubWindow } from "../../components/ui/SubWindow";
import { useI18n } from "../../i18n";
import type { FileEntry } from "../../ipc/bindings";
import { FilePreviewContent, type FileTextPreviewMeta } from "./FilePreviewContent";
import { formatFileSize } from "./utils";

export interface FilePreviewSubWindowProps {
  open: boolean;
  entry: FileEntry | null;
  connectionId: string;
  onClose: () => void;
  onDownload?: (entry: FileEntry) => void;
}

export function FilePreviewSubWindow({
  open,
  entry,
  connectionId,
  onClose,
  onDownload,
}: FilePreviewSubWindowProps) {
  const { t } = useI18n();
  const [textMode, setTextMode] = useState<ContentPreviewTextMode>("code");
  const [textPreviewMeta, setTextPreviewMeta] = useState<FileTextPreviewMeta | null>(null);

  useEffect(() => {
    setTextMode("code");
    setTextPreviewMeta(null);
  }, [entry?.path]);

  const webPreviewUrl =
    textPreviewMeta && isPreviewWebUrl(textPreviewMeta.text)
      ? normalizePreviewWebUrl(textPreviewMeta.text)
      : null;

  const title = entry ? (
    <h2 id="subwindow-title" className="subwindow-title file-preview-subwindow-title">
      <span className="file-preview-subwindow-name">{entry.name}</span>
      {entry.size != null ? (
        <span className="file-preview-subwindow-meta">{formatFileSize(entry.size)}</span>
      ) : null}
    </h2>
  ) : (
    t("files.preview.title")
  );

  const headerExtra =
    textPreviewMeta || (entry && onDownload) ? (
      <div className="file-preview-subwindow-header-actions">
        {textPreviewMeta ? (
          <ContentPreviewTextModeToolbar
            mode={textMode}
            onModeChange={setTextMode}
            showCodeMode={Boolean(textPreviewMeta.codeLanguage)}
            showWebMode={webPreviewUrl != null}
          />
        ) : null}
        {entry && onDownload ? (
          <button
            type="button"
            className="file-preview-subwindow-download"
            onClick={() => onDownload(entry)}
          >
            {t("files.actions.download")}
          </button>
        ) : null}
      </div>
    ) : null;

  return (
    <SubWindow
      open={open}
      title={title}
      onClose={onClose}
      className="file-preview-subwindow"
      widthRatio={0.82}
      heightRatio={0.78}
      headerExtra={headerExtra}
    >
      {entry ? (
        <FilePreviewContent
          connectionId={connectionId}
          entry={entry}
          textMode={textMode}
          onTextModeChange={setTextMode}
          showInlineTextModeToolbar={false}
          onTextPreviewMetaChange={setTextPreviewMeta}
        />
      ) : null}
    </SubWindow>
  );
}
