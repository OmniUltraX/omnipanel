import { useCallback, useEffect, useRef, type KeyboardEvent, type MouseEvent } from "react";
import { useI18n } from "../../../i18n";
import type { TreeChartListPanel, TreeChartPanelStats } from "./treeChartTypes";
import { isFirstTreeChartPanelSelection } from "./treeChartTypes";

interface TreeChartListViewProps {
  panel: TreeChartListPanel;
  selectedRowIndex: number | null;
  onRowClick: (rowIndex: number) => void;
  /** 上游未选择时保持空白 */
  awaitingParentSelection?: boolean;
  stats?: TreeChartPanelStats | null;
  /** 是否显示上/下游关联 ID 列 */
  showIds?: boolean;
}

function resolveNextRowIndex(
  current: number | null,
  delta: number,
  rowCount: number,
): number {
  if (rowCount <= 0) {
    return 0;
  }
  if (current == null) {
    return delta > 0 ? 0 : rowCount - 1;
  }
  const next = current + delta;
  return Math.max(0, Math.min(rowCount - 1, next));
}

function hasTextSelection(): boolean {
  const selection = window.getSelection();
  return Boolean(selection && selection.type === "Range" && selection.toString().length > 0);
}

export function TreeChartListView({
  panel,
  selectedRowIndex,
  onRowClick,
  awaitingParentSelection = false,
  stats = null,
  showIds = true,
}: TreeChartListViewProps) {
  const { t } = useI18n();
  const listRef = useRef<HTMLUListElement>(null);
  const showUpstream = showIds && !isFirstTreeChartPanelSelection(panel.selection);
  const showDownstreamId = showIds;
  const showStats = stats != null;

  const focusList = useCallback(() => {
    listRef.current?.focus();
  }, []);

  const selectRow = useCallback(
    (rowIndex: number) => {
      if (rowIndex < 0 || rowIndex >= panel.rows.length) {
        return;
      }
      if (rowIndex === selectedRowIndex) {
        focusList();
        return;
      }
      onRowClick(rowIndex);
      focusList();
    },
    [focusList, onRowClick, panel.rows.length, selectedRowIndex],
  );

  const handleRowClick = useCallback(
    (rowIndex: number, event: MouseEvent<HTMLLIElement>) => {
      if (hasTextSelection()) {
        event.stopPropagation();
        return;
      }
      selectRow(rowIndex);
    },
    [selectRow],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLUListElement>) => {
      if (panel.rows.length === 0) {
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        selectRow(resolveNextRowIndex(selectedRowIndex, 1, panel.rows.length));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        selectRow(resolveNextRowIndex(selectedRowIndex, -1, panel.rows.length));
      }
    },
    [panel.rows.length, selectRow, selectedRowIndex],
  );

  useEffect(() => {
    if (selectedRowIndex == null) {
      return;
    }
    listRef.current
      ?.querySelector<HTMLElement>(".tree-chart-list__row--active")
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedRowIndex, panel.rows.length]);

  if (awaitingParentSelection) {
    return null;
  }

  if (panel.loading) {
    return <div className="tree-chart-panel__empty">{t("common.loading")}</div>;
  }

  if (panel.error) {
    return <div className="tree-chart-panel__empty tree-chart-panel__empty--error">{panel.error}</div>;
  }

  if (panel.rows.length === 0) {
    return <div className="tree-chart-panel__empty">{t("database.treeChart.noRows")}</div>;
  }

  return (
    <ul
      ref={listRef}
      role="listbox"
      tabIndex={0}
      aria-activedescendant={
        selectedRowIndex != null ? `tree-chart-row-${panel.id}-${selectedRowIndex}` : undefined
      }
      className={`tree-chart-list${selectedRowIndex != null ? " tree-chart-list--has-selection" : ""}${
        showIds ? "" : " tree-chart-list--hide-ids"
      }`}
      onKeyDown={handleKeyDown}
    >
      {panel.rows.map((row, index) => {
        const downstreamCount = stats?.countsByRowIndex[index];
        const isActive = selectedRowIndex === index;
        return (
          <li
            id={`tree-chart-row-${panel.id}-${index}`}
            key={`${row.label}-${row.upstreamRelation ?? ""}-${row.downstreamRelation}-${index}`}
            role="option"
            aria-selected={isActive}
            className={`tree-chart-list__row${isActive ? " tree-chart-list__row--active" : ""}`}
            onClick={(event) => handleRowClick(index, event)}
          >
            {showUpstream ? (
              <span className="tree-chart-list__upstream tree-chart-list__cell" title={row.upstreamRelation}>
                {row.upstreamRelation || "—"}
              </span>
            ) : null}
            <span className="tree-chart-list__label tree-chart-list__cell" title={row.label}>
              {row.label || "—"}
            </span>
            {showDownstreamId ? (
              <span className="tree-chart-list__relation tree-chart-list__cell" title={row.downstreamRelation}>
                {row.downstreamRelation || "—"}
              </span>
            ) : null}
            {showStats ? (
              <span
                className="tree-chart-list__count tree-chart-list__cell"
                title={t("database.treeChart.downstreamRowCount")}
              >
                {stats.loading
                  ? "…"
                  : downstreamCount != null
                    ? downstreamCount
                    : "0"}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
