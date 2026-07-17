import { useEffect, useMemo, useState } from "react";
import type { CodeEditorLanguage } from "../../../components/ui/content/CodeEditor";
import {
  ContentPreviewView,
  ContentPreviewTextModeToolbar,
  useContentPreviewTextModes,
  type ContentPreviewTextMode,
} from "../../../components/ui/content/ContentPreviewView";
import { SubWindow } from "../../../components/ui/window/SubWindow";
import { useI18n } from "../../../i18n";
import { resolvePreferredPreviewTextMode } from "../../../lib/contentPreview";
import {
  resolveCellPreviewCodeLanguage,
  resolveCellPreviewContent,
  type CellPreviewState,
} from "./tableCellPreview";

export interface TableCellPreviewSubWindowProps {
  open: boolean;
  preview: CellPreviewState | null;
  onClose: () => void;
}

export function TableCellPreviewSubWindow({
  open,
  preview,
  onClose,
}: TableCellPreviewSubWindowProps) {
  const { t } = useI18n();
  const [textMode, setTextMode] = useState<ContentPreviewTextMode>("plain");

  const content = useMemo(
    () =>
      preview
        ? resolveCellPreviewContent(preview.value, preview.columnType, { sniffContent: true })
        : null,
    [preview],
  );

  const isMediaPreview = content?.kind === "image" || content?.kind === "audio";

  const codeLanguage = useMemo(
    (): CodeEditorLanguage | undefined =>
      preview && content ? resolveCellPreviewCodeLanguage(preview.columnType, content) : undefined,
    [preview, content],
  );

  const sourceText = content?.kind === "text" ? content.text : undefined;
  const modeOptions = useContentPreviewTextModes(sourceText, codeLanguage, content?.kind);

  useEffect(() => {
    if (!content || isMediaPreview) {
      return;
    }
    setTextMode(resolvePreferredPreviewTextMode(content));
  }, [preview?.column, preview?.rowIndex, content, isMediaPreview]);

  const title = preview ? (
    <h2 id="subwindow-title" className="subwindow-title file-preview-subwindow-title">
      <span className="file-preview-subwindow-name">{preview.column}</span>
      <span className="file-preview-subwindow-meta">
        {t("database.results.cellPreviewRow", { row: preview.rowIndex + 1 })}
        {preview.columnType ? ` · ${preview.columnType}` : ""}
      </span>
    </h2>
  ) : (
    t("database.results.cellPreviewTitle")
  );

  const headerExtra =
    content && !isMediaPreview ? (
      <div className="file-preview-subwindow-header-actions">
        <ContentPreviewTextModeToolbar
          mode={textMode}
          onModeChange={setTextMode}
          showCodeMode={modeOptions.showCodeMode}
          showJsonMode={modeOptions.showJsonMode}
          showMarkdownMode={modeOptions.showMarkdownMode}
          showWebMode={modeOptions.showWebMode}
        />
      </div>
    ) : null;

  return (
    <SubWindow
      open={open}
      title={title}
      onClose={onClose}
      className="db-cell-preview-subwindow file-preview-subwindow"
      widthRatio={0.72}
      heightRatio={0.68}
      windowChrome={false}
      showHeaderClose={false}
      headerExtra={headerExtra}
    >
      {preview && content ? (
        <ContentPreviewView
          status="ready"
          content={content}
          textMode={textMode}
          onTextModeChange={setTextMode}
          codeLanguage={content.kind === "text" ? codeLanguage : "json"}
          showTextModeToolbar={false}
          className="content-preview-view--subwindow"
          contentResetKey={`${preview.column}|${preview.rowIndex}`}
        />
      ) : null}
    </SubWindow>
  );
}
