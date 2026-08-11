import { startTransition } from "react";
import { afterPaintIdle, yieldToMain } from "../../../lib/yieldToMain";
import type { TablePreviewResult } from "../api";
import type { RuleGroupType } from "react-querybuilder";
import {
  createDefaultTablePreviewState,
  type SortState,
  type TablePreviewState,
} from "./dbWorkspaceState";
import {
  clearTablePreviewRowCache,
  patchTablePreviewRowCacheRows,
  resetTablePreviewRowCache,
  setTablePreviewRowCache,
} from "./tablePreviewRowCache";

type TablePreviewsMap = Record<string, TablePreviewState>;
type SetTablePreviews = (
  updater: TablePreviewsMap | ((prev: TablePreviewsMap) => TablePreviewsMap),
) => void;

/** 每个 Tab 的灌数代数：切换表 / 重新加载时 bump，取消进行中的分片写入 */
const applyGenerationByTab = new Map<string, number>();

export function bumpTablePreviewApplyGeneration(
  tabId: string,
  options?: { /** true：写入空 cache（换表硬重置）；默认 delete，刷新时可回退旧行 */ resetCache?: boolean },
): number {
  const next = (applyGenerationByTab.get(tabId) ?? 0) + 1;
  applyGenerationByTab.set(tabId, next);
  if (options?.resetCache) {
    // 空 cache + notify → Canvas 画空行，禁止回退旧 displayRows（#44）
    resetTablePreviewRowCache(tabId);
  } else {
    // 取消在途灌数时清掉 cache；订阅方回退 displayRows，同表刷新不闪空
    clearTablePreviewRowCache(tabId);
  }
  return next;
}

export function getTablePreviewApplyGeneration(tabId: string): number {
  return applyGenerationByTab.get(tabId) ?? 0;
}

export type BeginTablePreviewFetchPatch = {
  connId?: string;
  dbName?: string;
  tableName?: string;
  pageSize?: number;
  page?: number;
  sort?: SortState | null;
  filter?: RuleGroupType | null;
  loading?: boolean;
};

/**
 * 发起新的表预览请求前：bump 代数、重置 cache 为空、重置展示（避免 Canvas / React 残留旧表数据）。
 * 注意：不能只 clear cache——订阅方在 React 重渲前会回退到旧 displayRows，旧表会盖在新表头上（#44）。
 */
export function beginTablePreviewFetch(
  tabId: string,
  setTablePreviews: SetTablePreviews,
  patch: BeginTablePreviewFetchPatch = {},
): number {
  const generation = bumpTablePreviewApplyGeneration(tabId, { resetCache: true });
  setTablePreviews((prev) => {
    const existing = prev[tabId] ?? createDefaultTablePreviewState();
    return {
      ...prev,
      [tabId]: {
        ...createDefaultTablePreviewState(),
        pageSize: patch.pageSize ?? existing.pageSize,
        page: patch.page ?? existing.page,
        sort: patch.sort !== undefined ? patch.sort : existing.sort,
        filter: patch.filter !== undefined ? patch.filter : existing.filter,
        connId: patch.connId ?? existing.connId,
        dbName: patch.dbName ?? existing.dbName,
        tableName: patch.tableName ?? existing.tableName,
        loading: patch.loading ?? true,
        error: null,
        data: null,
        totalRows: 0,
      },
    };
  });
  return generation;
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
  /**
   * Canvas 渲染模式下，Phase 3（完整 rows 进 React）延迟到两帧 paint + idle 后执行。
   * Canvas 在 Phase 2 cache notify 时已画出数据，Phase 3 的 React rows 仅服务编辑/DOM 路径，
   * 无需与首帧争主线程。DOM 模式必须立即执行（否则网格空）。
   */
  canvasMode?: boolean;
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
    canvasMode = false,
  } = params;

  const isStale = () => getTablePreviewApplyGeneration(tabId) !== generation;

  if (isStale()) return;

  const isEmpty = data.rows.length === 0;

  // Phase 1：元数据进 React（必须轻）
  // 有数据且 Canvas 模式：同表刷新可暂留旧 rows，避免 cache notify 前整表闪空。
  // 列结构变了（预览 Tab 原地换表）绝不能留旧 rows，否则新表头会配旧行（#44）。
  // 空结果：必须 rows=[]，否则过滤无匹配时仍显示上次数据（#47）。
  setTablePreviews((prevMap) => {
    const cur = prevMap[tabId];
    const prevData = cur?.data;
    const sameColumns =
      !!prevData &&
      prevData.columns.length === data.columns.length &&
      prevData.columns.every((col, index) => col === data.columns[index]);
    const phase1Rows = isEmpty
      ? []
      : canvasMode && sameColumns
        ? (prevData?.rows ?? [])
        : [];
    return {
      ...prevMap,
      [tabId]: {
        ...(cur ?? createDefaultTablePreviewState()),
        loading: false,
        error: null,
        data: {
          name: data.name,
          columns: data.columns,
          rows: phase1Rows,
        },
        totalRows,
        page,
        pageSize,
      },
    };
  });

  await yieldToMain();
  if (isStale()) return;

  if (isEmpty) {
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
  const writeFullRows = () => {
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
  };

  if (canvasMode) {
    // Canvas 模式：数据已在 Phase 2 经 cache notify 画出。
    // Phase 3 的 React rows 仅服务编辑/DOM 路径，延迟到两帧 paint + idle 后写入，
    // 避免与 Canvas 首帧争主线程导致点击不跟手。
    await new Promise<void>((resolve) => {
      afterPaintIdle(() => {
        startTransition(writeFullRows);
        resolve();
      }, 500);
    });
  } else {
    startTransition(writeFullRows);
  }
}
