import { startTransition } from "react";
import { yieldToMain } from "../../../lib/yieldToMain";
import type { TablePreviewResult } from "../api";
import {
  createDefaultTablePreviewState,
  type TablePreviewState,
} from "./dbWorkspaceState";
import {
  clearTablePreviewRowCache,
  patchTablePreviewRowCacheRows,
  setTablePreviewRowCache,
} from "./tablePreviewRowCache";

type TablePreviewsMap = Record<string, TablePreviewState>;
type SetTablePreviews = (
  updater: TablePreviewsMap | ((prev: TablePreviewsMap) => TablePreviewsMap),
) => void;

/** 每个 Tab 的灌数代数：切换表 / 重新加载时 bump，取消进行中的分片写入 */
const applyGenerationByTab = new Map<string, number>();

export function bumpTablePreviewApplyGeneration(tabId: string): number {
  const next = (applyGenerationByTab.get(tabId) ?? 0) + 1;
  applyGenerationByTab.set(tabId, next);
  // 取消在途灌数时清掉 cache，避免画旧表
  clearTablePreviewRowCache(tabId);
  return next;
}

export function getTablePreviewApplyGeneration(tabId: string): number {
  return applyGenerationByTab.get(tabId) ?? 0;
}

export type ApplyTablePreviewDataParams = {
  tabId: string;
  data: TablePreviewResult;
  totalRows: number;
  page: number;
  pageSize: number;
  setTablePreviews: SetTablePreviews;
  generation: number;
  /**
   * cache 分片大小。片间 yield，只 notify Canvas，不 setState。
   * 默认 12。
   */
  chunkSize?: number;
};

/**
 * 加载策略（解决「右侧加载堵死全局 UI」）：
 *
 * 1. React 只做一次轻更新：columns + 空 rows + loading:false
 * 2. 行数据写入 React 外的 rowCache，分片 notify → Canvas invalidate（无 reconcile）
 * 3. 全部进 cache 后再 startTransition 把完整 rows 同步进 Zustand（编辑/DOM 路径）
 *
 * 旧方案「分片 setState」每次都重渲 TableDataGrid，比一次灌完更卡。
 */
export async function applyTablePreviewDataProgressive(
  params: ApplyTablePreviewDataParams,
): Promise<void> {
  const {
    tabId,
    data,
    totalRows,
    page,
    pageSize,
    setTablePreviews,
    generation,
    chunkSize = 12,
  } = params;

  const isStale = () => getTablePreviewApplyGeneration(tabId) !== generation;

  if (isStale()) return;

  // Phase 1：元数据进 React（必须轻）
  setTablePreviews((prevMap) => {
    const cur = prevMap[tabId];
    return {
      ...prevMap,
      [tabId]: {
        ...(cur ?? createDefaultTablePreviewState()),
        loading: false,
        error: null,
        data: {
          name: data.name,
          columns: data.columns,
          rows: [],
        },
        totalRows,
        page,
        pageSize,
      },
    };
  });

  await yieldToMain();
  if (isStale()) return;

  if (data.rows.length === 0) {
    setTablePreviewRowCache(tabId, null);
    return;
  }

  const meta = { name: data.name, columns: data.columns };
  const size = Math.max(1, chunkSize);

  // Phase 2：只写 cache + notify Canvas，禁止 setState
  for (let end = size; ; end += size) {
    if (isStale()) return;
    const sliceEnd = Math.min(end, data.rows.length);
    patchTablePreviewRowCacheRows(tabId, data.rows.slice(0, sliceEnd), meta);
    if (sliceEnd >= data.rows.length) {
      break;
    }
    await yieldToMain();
  }

  if (isStale()) return;
  await yieldToMain();
  if (isStale()) return;

  // Phase 3：完整 rows 进 React（低优先，不跟侧栏抢）
  const fullRows = data.rows;
  startTransition(() => {
    if (isStale()) return;
    setTablePreviews((prevMap) => {
      const cur = prevMap[tabId];
      if (!cur) return prevMap;
      return {
        ...prevMap,
        [tabId]: {
          ...cur,
          data: {
            name: data.name,
            columns: data.columns,
            rows: fullRows,
          },
        },
      };
    });
  });
}
