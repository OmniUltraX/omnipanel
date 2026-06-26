import { useEffect, useMemo, useState } from "react";
import { Button } from "../../components/ui/Button";
import {
  ContentPreviewTextModeToolbar,
  ContentPreviewView,
  useContentPreviewTextModes,
  type ContentPreviewTextMode,
} from "../../components/ui/ContentPreviewView";
import { DetailPanelModeToggle, DetailPanelShell } from "../../components/ui/DetailPanelShell";
import { useI18n } from "../../i18n";
import { resolveCellPreviewContent } from "./tableCellPreview";

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

export function TableDataGridCellPreviewDrawer({
  preview,
  onClose,
}: TableDataGridCellPreviewDrawerProps) {
  const { t } = useI18n();
  const open = preview !== null;
  const [textPreviewMode, setTextPreviewMode] = useState<ContentPreviewTextMode>("plain");

  const content = useMemo(() => {
    if (!preview) return null;
    return resolveCellPreviewContent(preview.value, preview.columnType);
  }, [preview]);

  const textContent = content?.kind === "text" ? content.text : undefined;
  const { showWebMode } = useContentPreviewTextModes(textContent);

  useEffect(() => {
    setTextPreviewMode("plain");
  }, [preview?.column, preview?.rowIndex, preview?.rowLabel]);

  const floatingTitle = preview
    ? `${preview.column} · ${preview.rowLabel}`
    : t("database.results.cellPreviewTitle");

  const showTextModeToolbar = content?.kind === "text";

  const toolbar = showTextModeToolbar ? (
    <ContentPreviewTextModeToolbar
      mode={textPreviewMode}
      onModeChange={setTextPreviewMode}
      showWebMode={showWebMode}
    />
  ) : null;

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
      floatingHeaderExtra={toolbar}
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
              {toolbar}
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
          <div className="drawer-body db-cell-preview-drawer-body">
            <ContentPreviewView
              status="ready"
              content={content}
              textMode={textPreviewMode}
              onTextModeChange={setTextPreviewMode}
              showTextModeToolbar={false}
              contentResetKey={`${preview.column}|${preview.rowIndex}|${preview.rowLabel}`}
              className="content-preview-view--embedded"
            />
          </div>
        </>
      )}
    </DetailPanelShell>
  );
}
