import { invoke } from "@tauri-apps/api/core";
import type { TableRowDiff } from "./types";

export interface RowDiffKindCounts {
  changed: number;
  sourceOnly: number;
  targetOnly: number;
}

export interface RowDiffPageResult {
  diffs: Array<{
    rowKey: string;
    displayKey: string;
    kind: string;
    changedFields?: string[] | null;
    sourceRow?: Record<string, unknown> | null;
    targetRow?: Record<string, unknown> | null;
  }>;
  total: number;
  kindCounts: RowDiffKindCounts;
}

function mapDiffPayload(
  diff: RowDiffPageResult["diffs"][number],
): TableRowDiff {
  return {
    rowKey: diff.rowKey,
    displayKey: diff.displayKey,
    kind: diff.kind as TableRowDiff["kind"],
    changedFields: diff.changedFields ?? undefined,
    sourceRow: diff.sourceRow ?? undefined,
    targetRow: diff.targetRow ?? undefined,
  };
}

/** 从本地差异缓存分页读取冲突行。 */
export async function fetchRowDiffPage(
  cacheId: string,
  offset: number,
  limit: number,
  kinds?: string[],
): Promise<{ diffs: TableRowDiff[]; total: number; kindCounts: RowDiffKindCounts }> {
  const result = await invoke<RowDiffPageResult>("db_sync_row_diff_page", {
    cacheId,
    offset,
    limit,
    kinds: kinds && kinds.length > 0 ? kinds : null,
  });
  return {
    diffs: result.diffs.map(mapDiffPayload),
    total: result.total,
    kindCounts: result.kindCounts,
  };
}
