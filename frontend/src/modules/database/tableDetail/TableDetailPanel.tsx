import { useMemo, type ReactNode, type RefObject } from "react";
import { Button } from "../../../components/ui/Button";
import { useI18n } from "../../../i18n";
import type { DbColumnMeta } from "../api";
import { CellEditorPanel, type CellEditorPanelHandle } from "../cell_editor";
import type { DatabaseTableDetailPosition } from "../../../stores/settingsStore";
import { RecordPreviewTab } from "./RecordPreviewTab";
import { TableDdlViewer } from "../table/TableDdlViewer";

export type TableDetailTab = "record" | "value" | "ddl";

export type TableDetailDdlState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; ddl: string }
  | { status: "error"; message: string };

export interface TableDetailPanelProps {
  activeTab: TableDetailTab;
  onActiveTabChange: (tab: TableDetailTab) => void;
  position: DatabaseTableDetailPosition;
  onPositionChange: (position: DatabaseTableDetailPosition) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** 记录 Tab */
  columns: string[];
  columnMeta?: DbColumnMeta[];
  activeRow: Record<string, unknown> | null;
  cellOverrides?: Record<string, unknown>;
  onRecordFieldApply: (column: string, payload: { rawText: string; parsed: unknown }) => void;
  onRecordFieldSetNull?: (column: string) => void;
  /** 值 Tab — CellEditorPanel */
  cellEditorRef: RefObject<CellEditorPanelHandle | null>;
  cellKey: string | null;
  columnName: string | null;
  columnType: string;
  currentValue: unknown;
  selectionCount: number;
  editorOpen: boolean;
  rowIndex?: number | null;
  valueColumnMeta?: DbColumnMeta | null;
  dbType?: string;
  onValueApply: (payload: { rawText: string; parsed: unknown }) => void;
  onValueSetNull?: () => void;
  /** DDL Tab */
  showDdlTab?: boolean;
  ddlTitle?: string;
  ddlState?: TableDetailDdlState;
  onCopyDdl?: () => void;
  headerExtra?: ReactNode;
}

export function TableDetailPanel({
  activeTab,
  onActiveTabChange,
  position,
  onPositionChange,
  collapsed: _collapsed,
  onToggleCollapsed,
  columns,
  columnMeta,
  activeRow,
  cellOverrides,
  onRecordFieldApply,
  onRecordFieldSetNull,
  cellEditorRef,
  cellKey,
  columnName,
  columnType,
  currentValue,
  selectionCount,
  editorOpen,
  rowIndex = null,
  valueColumnMeta = null,
  dbType,
  onValueApply,
  onValueSetNull,
  showDdlTab = false,
  ddlTitle,
  ddlState = { status: "idle" },
  onCopyDdl,
  headerExtra,
}: TableDetailPanelProps) {
  const { t } = useI18n();
  const nextPosition: DatabaseTableDetailPosition = position === "right" ? "bottom" : "right";

  const tabs = useMemo(() => {
    const list: Array<{ id: TableDetailTab; label: string }> = [
      { id: "record", label: t("database.tableDetail.recordTab") },
      { id: "value", label: t("database.tableDetail.valueTab") },
    ];
    if (showDdlTab) {
      list.push({ id: "ddl", label: t("database.tableDetail.ddlTab") });
    }
    return list;
  }, [showDdlTab, t]);

  const canCopyDdl = ddlState.status === "loaded" && Boolean(ddlState.ddl);

  return (
    <div className={`db-table-detail-panel db-table-detail-panel--${position}`}>
      <div className="db-table-detail-panel-header">
        <div className="db-table-detail-tabs" role="tablist">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={`db-table-detail-tab${activeTab === tab.id ? " is-active" : ""}`}
              onClick={() => onActiveTabChange(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="db-table-detail-panel-actions">
          {activeTab === "ddl" && onCopyDdl ? (
            <Button
              variant="ghost"
              size="icon-sm"
              title={t("database.contextMenu.copyDdl")}
              aria-label={t("database.contextMenu.copyDdl")}
              disabled={!canCopyDdl}
              onClick={onCopyDdl}
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" width="14" height="14" aria-hidden>
                <rect x="5" y="5" width="9" height="9" rx="1.5" />
                <path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H11" />
              </svg>
            </Button>
          ) : null}
          {headerExtra}
          <Button
            variant="ghost"
            size="icon-sm"
            title={
              position === "right"
                ? t("database.tableDetail.moveToBottom")
                : t("database.tableDetail.moveToRight")
            }
            aria-label={
              position === "right"
                ? t("database.tableDetail.moveToBottom")
                : t("database.tableDetail.moveToRight")
            }
            onClick={() => onPositionChange(nextPosition)}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14" aria-hidden>
              {position === "right" ? (
                <>
                  <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
                  <path d="M2 10.5h12" />
                </>
              ) : (
                <>
                  <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
                  <path d="M10 2.5v11" />
                </>
              )}
            </svg>
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            title={t("common.close")}
            aria-label={t("common.close")}
            onClick={onToggleCollapsed}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" width="14" height="14" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </Button>
        </div>
      </div>
      <div className="db-table-detail-panel-body">
        {activeTab === "record" ? (
          <RecordPreviewTab
            columns={columns}
            columnMeta={columnMeta}
            row={activeRow}
            cellOverrides={cellOverrides}
            onApply={onRecordFieldApply}
            onSetNull={onRecordFieldSetNull}
          />
        ) : activeTab === "value" ? (
          <CellEditorPanel
            ref={cellEditorRef}
            cellKey={cellKey}
            columnName={columnName}
            columnType={columnType}
            currentValue={currentValue}
            selectionCount={selectionCount}
            editorOpen={editorOpen}
            rowIndex={rowIndex}
            columnMeta={valueColumnMeta}
            dbType={dbType}
            onApply={onValueApply}
            onSetNull={onValueSetNull}
          />
        ) : (
          <div className="db-table-detail-ddl">
            {ddlTitle ? <div className="db-table-detail-ddl__title">{ddlTitle}</div> : null}
            <div className="db-table-detail-ddl__body">
              {ddlState.status === "loading" || ddlState.status === "idle" ? (
                <div className="db-tables-panel-ddl-status">{t("database.tablesPanel.ddlLoading")}</div>
              ) : null}
              {ddlState.status === "error" ? (
                <div className="db-tables-panel-ddl-status db-tables-panel-ddl-status--error">
                  {t("database.tablesPanel.ddlFailed", { message: ddlState.message })}
                </div>
              ) : null}
              {ddlState.status === "loaded" && ddlState.ddl ? (
                <TableDdlViewer ddl={ddlState.ddl} />
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
