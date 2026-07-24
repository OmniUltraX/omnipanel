import { startTransition } from "react";
import { afterPaintIdle, yieldToMain } from "../../../lib/yieldToMain";
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

  // Phase 1：元数据进 React（必须轻）
  // Canvas 模式下不写 data.rows（保持原引用），避免 previewDisplayRows 重算触发
  // TableDataGrid 重渲——此时 Canvas 尚未收到 cache notify，重渲纯冗余。
  // columns 更新是必要的（表头需要列名）；rows 由 Phase 2 cache + Phase 3 延迟写入负责。
  setTablePreviews((prevMap) => {
    const cur = prevMap[tabId];
    const prevData = cur?.data;
    return {
      ...prevMap,
      [tabId]: {
        ...(cur ?? createDefaultTablePreviewState()),
        loading: false,
        error: null,
        data: {
          name: data.name,
          columns: data.columns,
          rows: canvasMode ? (prevData?.rows ?? []) : [],
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
