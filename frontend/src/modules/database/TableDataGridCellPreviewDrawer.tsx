import { useMemo } from "react";
import JsonView from "@uiw/react-json-view";
import { darkTheme } from "@uiw/react-json-view/dark";
import { lightTheme } from "@uiw/react-json-view/light";
import { Button } from "../../components/ui/Button";
import { DetailPanelModeToggle, DetailPanelShell } from "../../components/ui/DetailPanelShell";
import { useI18n } from "../../i18n";
import { useSettingsStore } from "../../stores/settingsStore";
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
  const resolvedTheme = useSettingsStore((s) => s.resolved);
  const open = preview !== null;

  const content = useMemo(() => {
    if (!preview) return null;
    return resolveCellPreviewContent(preview.value, preview.columnType);
  }, [preview]);

  const jsonTheme = resolvedTheme === "dark" ? darkTheme : lightTheme;
  const floatingTitle = preview
    ? `${preview.column} · ${preview.rowLabel}`
    : t("database.results.cellPreviewTitle");

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
            <div className="docker-drawer-header-actions">
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
            ) : (
              <pre className="db-cell-preview-text">{content.text}</pre>
            )}
          </div>
        </>
      )}
    </DetailPanelShell>
  );
}
