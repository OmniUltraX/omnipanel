import { useEffect, useMemo, useState } from "react";
import JsonView from "@uiw/react-json-view";
import { darkTheme } from "@uiw/react-json-view/dark";
import { lightTheme } from "@uiw/react-json-view/light";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "../../components/ui/Button";
import { DetailPanelModeToggle, DetailPanelShell } from "../../components/ui/DetailPanelShell";
import { useI18n } from "../../i18n";
import { useSettingsStore } from "../../stores/settingsStore";
import {
  isCellWebUrl,
  normalizeCellWebUrl,
  resolveCellPreviewContent,
} from "./tableCellPreview";

export type TextCellPreviewMode = "plain" | "markdown" | "web";

export type TableDataGridCellPreview = {
  column: string;
  rowIndex: number;
  rowLabel: string;
  value: unknown;
  columnType?: string;
};

interface TableDataGridCellPreviewDrawerProps {
  preview: TableDataGridCellPreview | null;
  onClose: () => void;
}

function CellPreviewTextModeToolbar({
  mode,
  onModeChange,
  showWebMode,
}: {
  mode: TextCellPreviewMode;
  onModeChange: (mode: TextCellPreviewMode) => void;
  showWebMode: boolean;
}) {
  const { t } = useI18n();
  return (
    <div
      className="db-cell-preview-text-toolbar"
      role="group"
      aria-label={t("database.results.cellPreviewTextMode")}
    >
      <button
        type="button"
        className={`db-cell-preview-text-mode-btn${mode === "plain" ? " is-active" : ""}`}
        aria-pressed={mode === "plain"}
        onClick={() => onModeChange("plain")}
      >
        {t("database.results.cellPreviewModePlain")}
      </button>
      <button
        type="button"
        className={`db-cell-preview-text-mode-btn${mode === "markdown" ? " is-active" : ""}`}
        aria-pressed={mode === "markdown"}
        onClick={() => onModeChange("markdown")}
      >
        {t("database.results.cellPreviewModeMarkdown")}
      </button>
      {showWebMode ? (
        <button
          type="button"
          className={`db-cell-preview-text-mode-btn${mode === "web" ? " is-active" : ""}`}
          aria-pressed={mode === "web"}
          onClick={() => onModeChange("web")}
        >
          {t("database.results.cellPreviewModeWeb")}
        </button>
      ) : null}
    </div>
  );
}

export function TableDataGridCellPreviewDrawer({
  preview,
  onClose,
}: TableDataGridCellPreviewDrawerProps) {
  const { t } = useI18n();
  const resolvedTheme = useSettingsStore((s) => s.resolved);
  const open = preview !== null;
  const [textPreviewMode, setTextPreviewMode] = useState<TextCellPreviewMode>("plain");

  useEffect(() => {
    setTextPreviewMode("plain");
  }, [preview?.column, preview?.rowIndex, preview?.rowLabel]);

  const content = useMemo(() => {
    if (!preview) return null;
    return resolveCellPreviewContent(preview.value, preview.columnType);
  }, [preview]);

  const jsonTheme = resolvedTheme === "dark" ? darkTheme : lightTheme;
  const floatingTitle = preview
    ? `${preview.column} · ${preview.rowLabel}`
    : t("database.results.cellPreviewTitle");

  const showTextModeToolbar = content?.kind === "text";
  const webPreviewUrl =
    content?.kind === "text" && isCellWebUrl(content.text)
      ? normalizeCellWebUrl(content.text)
      : null;

  useEffect(() => {
    if (textPreviewMode === "web" && !webPreviewUrl) {
      setTextPreviewMode("plain");
    }
  }, [textPreviewMode, webPreviewUrl]);

  return (
    <DetailPanelShell
      open={open}
      onClose={onClose}
      ariaLabel={t("database.results.cellPreviewTitle")}
      floatingTitle={floatingTitle}
      variant="drawer"
      drawerClassName="db-cell-preview-drawer"
      widthRatio={0.45}
      heightRatio={0.75}
      floatingHeaderExtra={
        showTextModeToolbar ? (
          <CellPreviewTextModeToolbar
            mode={textPreviewMode}
            onModeChange={setTextPreviewMode}
            showWebMode={webPreviewUrl != null}
          />
        ) : null
      }
    >
      {preview && content && (
        <>
          <header className="drawer-header db-cell-preview-drawer-header">
            <div className="db-cell-preview-drawer-heading">
              <div className="db-cell-preview-drawer-eyebrow">
                {t("database.results.cellPreviewTitle")}
              </div>
              <h2 className="db-cell-preview-drawer-title">{preview.column}</h2>
              <div className="db-cell-preview-drawer-meta">
                {t("database.results.cellPreviewRow", { row: preview.rowLabel })}
                {preview.columnType ? (
                  <span className="db-cell-preview-drawer-type">{preview.columnType}</span>
                ) : null}
              </div>
            </div>
            <div className="docker-drawer-header-actions db-cell-preview-drawer-actions">
              {showTextModeToolbar ? (
                <CellPreviewTextModeToolbar
                  mode={textPreviewMode}
                  onModeChange={setTextPreviewMode}
                  showWebMode={webPreviewUrl != null}
                />
              ) : null}
              <DetailPanelModeToggle />
              <Button
                variant="icon"
                onClick={onClose}
                title={t("database.results.cellPreviewClose")}
                aria-label={t("database.results.cellPreviewClose")}
              >
                ×
              </Button>
            </div>
          </header>
          <div
            className={`drawer-body db-cell-preview-drawer-body${textPreviewMode === "web" && webPreviewUrl ? " db-cell-preview-drawer-body--web" : ""}`}
          >
            {content.kind === "json" ? (
              <div className="db-cell-preview-json">
                <JsonView
                  value={content.value}
                  style={{
                    ...jsonTheme,
                    backgroundColor: "transparent",
                    fontSize: 12,
                    fontFamily: "var(--font-mono, ui-monospace, monospace)",
                  }}
                  displayObjectSize={false}
                  displayDataTypes={false}
                  shortenTextAfterLength={0}
                />
              </div>
            ) : textPreviewMode === "web" && webPreviewUrl ? (
              <div className="db-cell-preview-web">
                <iframe
                  key={webPreviewUrl}
                  className="db-cell-preview-web-frame"
                  src={webPreviewUrl}
                  title={t("database.results.cellPreviewModeWeb")}
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                  referrerPolicy="no-referrer"
                />
              </div>
            ) : textPreviewMode === "markdown" ? (
              <div className="db-cell-preview-markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{content.text}</ReactMarkdown>
              </div>
            ) : (
              <pre className="db-cell-preview-text">{content.text}</pre>
            )}
          </div>
        </>
      )}
    </DetailPanelShell>
  );
}
