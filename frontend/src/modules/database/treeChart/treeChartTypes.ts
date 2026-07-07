import type { RuleGroupType } from "react-querybuilder";

export type TreeChartAssociationMode = "singleTable" | "junctionTable";

export interface TreeChartJunctionConfig {
  /** 中间表 TM */
  junctionTableName: string;
  /** TM 与上游表 T1 的关联字段 */
  junctionToUpstreamField: string;
  /** TM 与下游表 T2 的关联字段 */
  junctionToDownstreamField: string;
  /** 下游表 T2 上与 TM.junctionToDownstreamField 对应的字段，通常为 id */
  downstreamTableJoinField: string;
}

export interface TreeChartFieldSelection {
  /** 关联方式，默认单表；首面板始终为单表 */
  associationMode?: TreeChartAssociationMode;
  /** 单表模式的数据表；中间表模式为下游表 T2 */
  tableName: string;
  labelField: string;
  /** 下游关联字段（指向右侧下一面板） */
  downstreamRelationField: string;
  /** 上有关联字段（来自左侧上一面板），仅非首面板单表模式需要 */
  upstreamRelationField?: string;
  /** 中间表关联配置，仅 junctionTable 模式 */
  junction?: TreeChartJunctionConfig;
  /** 可选的数据过滤条件 */
  filter?: RuleGroupType | null;
}

export interface TreeChartRow {
  label: string;
  upstreamRelation?: string;
  downstreamRelation: string;
}

export interface TreeChartListPanel {
  id: string;
  selection: TreeChartFieldSelection;
  rows: TreeChartRow[];
  loading: boolean;
  error: string | null;
}

export interface TreeChartPanelStats {
  loading: boolean;
  countsByRowIndex: Record<number, number>;
}

export interface TreeChartHeaderState {
  connId: string;
  database: string;
}

export function isFirstTreeChartPanelSelection(selection: TreeChartFieldSelection): boolean {
  return !selection.upstreamRelationField && !isJunctionTableSelection(selection);
}

export function isJunctionTableSelection(selection: TreeChartFieldSelection): boolean {
  return selection.associationMode === "junctionTable" && Boolean(selection.junction);
}

export function resolveTreeChartAssociationMode(
  selection: Partial<TreeChartFieldSelection> | null | undefined,
): TreeChartAssociationMode {
  if (selection?.associationMode === "junctionTable" && selection.junction) {
    return "junctionTable";
  }
  return "singleTable";
}
