import { useCallback, useEffect, useRef, useState } from "react";
import {
  ContentPreviewTextModeToolbar,
  type ContentPreviewTextMode,
} from "../../components/ui/content/ContentPreviewView";
import { useTextEditorSubWindowActions } from "../../components/textEditor/useTextEditorSubWindowActions";
import { isPreviewWebUrl, normalizePreviewWebUrl } from "../../lib/contentPreview";
import { SubWindow } from "../../components/ui/window/SubWindow";
import { useI18n } from "../../i18n";
import type { FileEntry } from "../../ipc/bindings";
import {
  FilePreviewContent,
  type FileJsonViewMode,
  type FilePreviewContentHandle,
  type FileTextPreviewMeta,
} from "./FilePreviewContent";
import { IconDownload } from "./FilesPanelIcons";
import { formatFileSize } from "./utils";
import { cn } from "../../lib/utils";

export interface FilePreviewSubWindowProps {
  open: boolean;
  entry: FileEntry | null;
  connectionId: string;
  onClose: () => void;
  onDownload?: (entry: FileEntry) => void;
  onSaved?: (entry: FileEntry) => void;
  /** 自定义 IO 适配器（终端场景用，绕开 file_manager.connectionId） */
  customIO?: import("./FilePreviewContent").FilePreviewIO;
}

export function FilePreviewSubWindow({
  open,
  entry,
  connectionId,
  onClose,
  onDownload,
  onSaved,
  customIO,
}: FilePreviewSubWindowProps) {
  const { t } = useI18n();
  const contentRef = useRef<FilePreviewContentHandle>(null);
  const [textMode, setTextMode] = useState<ContentPreviewTextMode>("code");
  const [jsonViewMode, setJsonViewMode] = useState<FileJsonViewMode>("structured");
  const [textPreviewMeta, setTextPreviewMeta] = useState<FileTextPreviewMeta | null>(null);

  const { dirty, setDirty, saving, saveNotice, handleSave } = useTextEditorSubWindowActions(
    contentRef,
    {
      open,
      onSaved: entry ? () => onSaved?.(entry) : undefined,
    },
  );

  useEffect(() => {
    setTextMode("code");
    setJsonViewMode("structured");
    setTextPreviewMeta(null);
    setDirty(false);
  }, [entry?.path, setDirty]);

  const webPreviewUrl =
    textPreviewMeta && isPreviewWebUrl(textPreviewMeta.text)
      ? normalizePreviewWebUrl(textPreviewMeta.text)
      : null;

  const canSave = dirty && !saving && entry?.kind === "file";

  const title = entry ? (
    <h2 id="subwindow-title" className="subwindow-title file-preview-subwindow-title">
      <span className="file-preview-subwindow-name">
        {entry.name}
        {dirty ? <span className="file-preview-subwindow-dirty">*</span> : null}
      </span>
      {entry.size != null ? (
        <span className="file-preview-subwindow-meta">{formatFileSize(entry.size)}</span>
      ) : null}
      {saveNotice ? (
        <span className="file-preview-subwindow-save-notice">{saveNotice}</span>
      ) : null}
    </h2>
  ) : (
    t("files.preview.title")
  );

  const headerExtra =
    textPreviewMeta || canSave || (entry && onDownload) ? (
      <div className="file-preview-subwindow-header-actions">
        {textPreviewMeta?.jsonStructured ? (
          <div
            className="content-preview-text-toolbar"
            role="group"
            aria-label={t("contentPreview.textMode")}
          >
            <button
              type="button"
              className={cn(
                "content-preview-text-mode-btn",
                jsonViewMode === "structured" && "is-active",
              )}
              aria-pressed={jsonViewMode === "structured"}
              onClick={() => setJsonViewMode("structured")}
            >
              {t("contentPreview.modeJson")}
            </button>
            <button
              type="button"
              className={cn(
                "content-preview-text-mode-btn",
                jsonViewMode === "source" && "is-active",
              )}
              aria-pressed={jsonViewMode === "source"}
              onClick={() => setJsonViewMode("source")}
            >
              {t("contentPreview.modeCode")}
            </button>
          </div>
        ) : textPreviewMeta ? (
          <ContentPreviewTextModeToolbar
            mode={textMode}
            onModeChange={setTextMode}
            showCodeMode={Boolean(textPreviewMeta.codeLanguage)}
            showWebMode={webPreviewUrl != null}
          />
        ) : null}
        {canSave ? (
          <button
            type="button"
            className="file-preview-subwindow-save"
            onClick={() => void handleSave()}
            title={t("files.preview.saveShortcut")}
          >
            {saving ? t("files.preview.saving") : t("files.preview.save")}
          </button>
        ) : null}
        {entry && onDownload ? (
          <button
            type="button"
            className="fm-action-btn"
            onClick={() => onDownload(entry)}
            title={t("files.actions.download")}
            aria-label={t("files.actions.download")}
          >
            <IconDownload />
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
          ref={contentRef}
          connectionId={connectionId}
          entry={entry}
          textMode={textMode}
          onTextModeChange={setTextMode}
          jsonViewMode={jsonViewMode}
          showInlineTextModeToolbar={false}
          editable={entry.kind === "file"}
          onDirtyChange={setDirty}
          onTextPreviewMetaChange={setTextPreviewMeta}
          customIO={customIO}
        />
      ) : null}
    </SubWindow>
  );
}
