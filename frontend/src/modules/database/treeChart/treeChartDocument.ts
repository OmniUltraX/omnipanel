import type { RuleGroupType } from "react-querybuilder";
import type {
  TreeChartAssociationMode,
  TreeChartFieldSelection,
  TreeChartJunctionConfig,
} from "./treeChartTypes";
import {
  ensureTableFilterQuery,
  isTableFilterActive,
} from "../grid/tablePreviewFilter";
import {
  normalizeSelectedRowByPanelId,
  pruneSelectedRowByPanelId,
} from "./treeChartSession";

export const TREE_CHART_DOCUMENT_VERSION = 1;

export interface TreeChartDocumentPanel {
  id: string;
  selection: TreeChartFieldSelection;
}

export interface TreeChartDocument {
  version: typeof TREE_CHART_DOCUMENT_VERSION;
  connId: string;
  database: string;
  panels: TreeChartDocumentPanel[];
  /** 各面板当前选中的行索引，用于恢复级联状态 */
  selectedRowByPanelId?: Record<string, number>;
}

function normalizeJunctionConfig(raw: unknown): TreeChartJunctionConfig | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const junctionTableName =
    typeof record.junctionTableName === "string" ? record.junctionTableName : "";
  const junctionToUpstreamField =
    typeof record.junctionToUpstreamField === "string" ? record.junctionToUpstreamField : "";
  const junctionToDownstreamField =
    typeof record.junctionToDownstreamField === "string" ? record.junctionToDownstreamField : "";
  const downstreamTableJoinField =
    typeof record.downstreamTableJoinField === "string" ? record.downstreamTableJoinField : "";
  if (
    !junctionTableName ||
    !junctionToUpstreamField ||
    !junctionToDownstreamField ||
    !downstreamTableJoinField
  ) {
    return null;
  }
  return {
    junctionTableName,
    junctionToUpstreamField,
    junctionToDownstreamField,
    downstreamTableJoinField,
  };
}

export function normalizeTreeChartFieldSelection(
  raw: Record<string, unknown>,
): TreeChartFieldSelection | null {
  const tableName = typeof raw.tableName === "string" ? raw.tableName : "";
  const labelField = typeof raw.labelField === "string" ? raw.labelField : "";
  const downstreamRelationField =
    typeof raw.downstreamRelationField === "string"
      ? raw.downstreamRelationField
      : typeof raw.relationField === "string"
        ? raw.relationField
        : "";
  const associationMode: TreeChartAssociationMode =
    raw.associationMode === "junctionTable" ? "junctionTable" : "singleTable";
  const junction = normalizeJunctionConfig(raw.junction);

  if (associationMode === "junctionTable") {
    if (!tableName || !labelField || !downstreamRelationField || !junction) {
      return null;
    }
  } else if (!tableName || !labelField || !downstreamRelationField) {
    return null;
  }

  const upstreamRelationField =
    typeof raw.upstreamRelationField === "string" ? raw.upstreamRelationField : undefined;
  const filterRaw = raw.filter;
  let filter: RuleGroupType | null | undefined;
  if (filterRaw !== undefined) {
    const prepared = ensureTableFilterQuery(
      filterRaw && typeof filterRaw === "object" ? (filterRaw as RuleGroupType) : undefined,
    );
    filter = isTableFilterActive(prepared) ? prepared : null;
  }

  const selection: TreeChartFieldSelection = {
    tableName,
    labelField,
    downstreamRelationField,
    associationMode,
    ...(associationMode === "singleTable" && upstreamRelationField
      ? { upstreamRelationField }
      : {}),
    ...(associationMode === "junctionTable" && junction ? { junction } : {}),
    ...(filter !== undefined ? { filter } : {}),
  };

  return selection;
}

function isFieldSelection(value: unknown): value is TreeChartFieldSelection {
  if (!value || typeof value !== "object") {
    return false;
  }
  return normalizeTreeChartFieldSelection(value as Record<string, unknown>) !== null;
}

export function createEmptyTreeChartDocument(): TreeChartDocument {
  return {
    version: TREE_CHART_DOCUMENT_VERSION,
    connId: "",
    database: "",
    panels: [],
  };
}

export function parseTreeChartDocument(raw: string | undefined | null): TreeChartDocument {
  if (!raw?.trim()) {
    return createEmptyTreeChartDocument();
  }
  try {
    const parsed = JSON.parse(raw) as Partial<TreeChartDocument>;
    const panels = Array.isArray(parsed.panels)
      ? parsed.panels
          .filter(
            (panel): panel is TreeChartDocumentPanel =>
              Boolean(panel) &&
              typeof panel === "object" &&
              typeof (panel as TreeChartDocumentPanel).id === "string" &&
              isFieldSelection((panel as TreeChartDocumentPanel).selection),
          )
          .map((panel) => ({
            id: panel.id,
            selection:
              normalizeTreeChartFieldSelection(
                panel.selection as unknown as Record<string, unknown>,
              ) ?? panel.selection,
          }))
      : [];
    const panelIds = panels.map((panel) => panel.id);
    const selectedRowByPanelId = normalizeSelectedRowByPanelId(
      parsed.selectedRowByPanelId,
      panelIds,
    );
    return {
      version: TREE_CHART_DOCUMENT_VERSION,
      connId: typeof parsed.connId === "string" ? parsed.connId : "",
      database: typeof parsed.database === "string" ? parsed.database : "",
      panels,
      ...(Object.keys(selectedRowByPanelId).length > 0 ? { selectedRowByPanelId } : {}),
    };
  } catch {
    return createEmptyTreeChartDocument();
  }
}

export function serializeTreeChartDocument(doc: TreeChartDocument): string {
  const selectedRowByPanelId =
    doc.selectedRowByPanelId && Object.keys(doc.selectedRowByPanelId).length > 0
      ? pruneSelectedRowByPanelId(
          doc.panels,
          doc.selectedRowByPanelId,
        )
      : undefined;

  return JSON.stringify(
    {
      version: TREE_CHART_DOCUMENT_VERSION,
      connId: doc.connId,
      database: doc.database,
      panels: doc.panels.map((panel) => ({
        id: panel.id,
        selection: panel.selection,
      })),
      ...(selectedRowByPanelId && Object.keys(selectedRowByPanelId).length > 0
        ? { selectedRowByPanelId }
        : {}),
    },
    null,
    2,
  );
}

export function buildTreeChartDocument(
  connId: string,
  database: string,
  panels: Array<{ id: string; selection: TreeChartFieldSelection }>,
  selectedRowByPanelId?: Record<string, number>,
): TreeChartDocument {
  const prunedSelection = selectedRowByPanelId
    ? pruneSelectedRowByPanelId(panels, selectedRowByPanelId)
    : undefined;

  return {
    version: TREE_CHART_DOCUMENT_VERSION,
    connId,
    database,
    panels: panels.map((panel) => ({
      id: panel.id,
      selection: panel.selection,
    })),
    ...(prunedSelection && Object.keys(prunedSelection).length > 0
      ? { selectedRowByPanelId: prunedSelection }
      : {}),
  };
}
