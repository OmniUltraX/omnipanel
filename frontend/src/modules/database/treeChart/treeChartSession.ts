import type { DbConnectionConfig } from "../api";
import type { TreeChartFieldSelection, TreeChartListPanel } from "./treeChartTypes";
import { fetchTreeChartFilteredRows, fetchTreeChartRows } from "./treeChartQuery";

function createEmptyRuntimePanel(
  id: string,
  selection: TreeChartFieldSelection,
): TreeChartListPanel {
  return {
    id,
    selection,
    rows: [],
    loading: false,
    error: null,
  };
}

/** 仅保留从首面板起连续有效的选中链 */
export function pruneSelectedRowByPanelId(
  panels: Array<{ id: string }>,
  selected: Record<string, number>,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (let index = 0; index < panels.length; index += 1) {
    const panelId = panels[index].id;
    const rowIndex = selected[panelId];
    if (typeof rowIndex !== "number" || !Number.isInteger(rowIndex) || rowIndex < 0) {
      break;
    }
    result[panelId] = rowIndex;
  }
  return result;
}

export function normalizeSelectedRowByPanelId(
  raw: unknown,
  panelIdsInOrder: string[],
): Record<string, number> {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const selected = raw as Record<string, unknown>;
  const result: Record<string, number> = {};
  for (const panelId of panelIdsInOrder) {
    const rowIndex = selected[panelId];
    if (typeof rowIndex !== "number" || !Number.isInteger(rowIndex) || rowIndex < 0) {
      break;
    }
    result[panelId] = rowIndex;
  }
  return result;
}

export async function restoreTreeChartPanels(
  panels: Array<{ id: string; selection: TreeChartFieldSelection }>,
  selectedRowByPanelId: Record<string, number>,
  connection: DbConnectionConfig,
  database: string,
): Promise<TreeChartListPanel[]> {
  if (panels.length === 0) {
    return [];
  }

  const restored: TreeChartListPanel[] = [];

  for (let index = 0; index < panels.length; index += 1) {
    const { id, selection } = panels[index];

    if (index === 0) {
      try {
        const rows = await fetchTreeChartRows(connection, database, selection);
        restored.push({ id, selection, rows, loading: false, error: null });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        restored.push({ id, selection, rows: [], loading: false, error: message });
        for (let rest = index + 1; rest < panels.length; rest += 1) {
          restored.push(createEmptyRuntimePanel(panels[rest].id, panels[rest].selection));
        }
        return restored;
      }
      continue;
    }

    const parentPanel = restored[index - 1];
    const rowIndex = selectedRowByPanelId[parentPanel.id];
    const parentRow =
      rowIndex != null && rowIndex >= 0 && rowIndex < parentPanel.rows.length
        ? parentPanel.rows[rowIndex]
        : null;

    if (!parentRow) {
      restored.push(createEmptyRuntimePanel(id, selection));
      for (let rest = index + 1; rest < panels.length; rest += 1) {
        restored.push(createEmptyRuntimePanel(panels[rest].id, panels[rest].selection));
      }
      return restored;
    }

    try {
      const rows = await fetchTreeChartFilteredRows(
        connection,
        database,
        selection,
        parentRow.downstreamRelation,
      );
      restored.push({ id, selection, rows, loading: false, error: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      restored.push({ id, selection, rows: [], loading: false, error: message });
      for (let rest = index + 1; rest < panels.length; rest += 1) {
        restored.push(createEmptyRuntimePanel(panels[rest].id, panels[rest].selection));
      }
      return restored;
    }
  }

  return restored;
}
