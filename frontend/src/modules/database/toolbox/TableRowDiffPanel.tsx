import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../../../components/ui/Button";
import { useI18n } from "../../../i18n";
import { DataLoading } from "../../../components/ui/DataLoading";
import type { DbColumnMeta } from "../api";
import { fetchRowDiffPage } from "./rowDiffCache";
import type { DataAnalysisResult, TableRowDiff } from "./types";

const ROW_DIFF_PAGE_SIZE = 50;

export type RowDiffKind = TableRowDiff["kind"];

const ALL_ROW_DIFF_KINDS: RowDiffKind[] = ["sourceOnly", "changed", "targetOnly"];

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  const text = String(value);
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

function rowDiffKindLabel(
  kind: RowDiffKind,
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  if (kind === "changed") {
    return t("database.toolbox.side.rowDiffChanged");
  }
  if (kind === "sourceOnly") {
    return t("database.toolbox.side.rowDiffSourceOnly");
  }
  return t("database.toolbox.side.rowDiffTargetOnly");
}

function useInlineDiffs(analysis: DataAnalysisResult | undefined): TableRowDiff[] {
  return useMemo(() => {
    if (analysis?.status !== "diff") {
      return [];
    }
    if (analysis.diffCacheId) {
      return [];
    }
    if (analysis.truncated) {
      return [];
    }
    return analysis.diffs ?? [];
  }, [analysis]);
}

export function TableRowDiffPanel({
  tableName,
  analysis,
  columns,
}: {
  tableName: string;
  analysis?: DataAnalysisResult;
  columns: DbColumnMeta[];
}) {
  const { t } = useI18n();
  const [page, setPage] = useState(0);
  const [kindFilters, setKindFilters] = useState<RowDiffKind[]>(ALL_ROW_DIFF_KINDS);
  const [pageDiffs, setPageDiffs] = useState<TableRowDiff[]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);

  const cacheId = analysis?.diffCacheId;
  const inlineDiffs = useInlineDiffs(analysis);
  const useCache = Boolean(cacheId && analysis?.status === "diff");

  useEffect(() => {
    setPage(0);
    setKindFilters(ALL_ROW_DIFF_KINDS);
    setPageDiffs([]);
    setTotalRows(0);
    setPageError(null);
    setPageLoading(false);
  }, [tableName, cacheId, analysis?.status, analysis?.diffRows]);

  const kindFilterKey = kindFilters.slice().sort().join(",");

  useEffect(() => {
    if (!useCache || !cacheId) {
      return;
    }

    let cancelled = false;
    setPageLoading(true);
    setPageError(null);

    const kinds =
      kindFilters.length > 0 && kindFilters.length < ALL_ROW_DIFF_KINDS.length
        ? kindFilters
        : undefined;

    void fetchRowDiffPage(cacheId, page * ROW_DIFF_PAGE_SIZE, ROW_DIFF_PAGE_SIZE, kinds)
      .then((result) => {
        if (cancelled) return;
        setPageDiffs(result.diffs);
        setTotalRows(result.total);
      })
      .catch((error) => {
        if (cancelled) return;
        setPageError(String(error));
        setPageDiffs([]);
        setTotalRows(0);
      })
      .finally(() => {
        if (!cancelled) {
          setPageLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [useCache, cacheId, page, kindFilterKey, kindFilters]);

  const filteredInlineDiffs = useMemo(() => {
    if (kindFilters.length === 0) {
      return [];
    }
    if (kindFilters.length >= ALL_ROW_DIFF_KINDS.length) {
      return inlineDiffs;
    }
    const allowed = new Set(kindFilters);
    return inlineDiffs.filter((diff) => allowed.has(diff.kind));
  }, [inlineDiffs, kindFilters]);

  const inlineTotalRows = filteredInlineDiffs.length;
  const inlineTotalPages = Math.max(1, Math.ceil(inlineTotalRows / ROW_DIFF_PAGE_SIZE));
  const inlineSafePage = Math.min(page, inlineTotalPages - 1);

  const inlinePageDiffs = useMemo(() => {
    const start = inlineSafePage * ROW_DIFF_PAGE_SIZE;
    return filteredInlineDiffs.slice(start, start + ROW_DIFF_PAGE_SIZE);
  }, [filteredInlineDiffs, inlineSafePage]);

  const displayDiffs = useCache ? pageDiffs : inlinePageDiffs;
  const displayTotalRows = useCache ? totalRows : inlineTotalRows;
  const totalPages = Math.max(1, Math.ceil(displayTotalRows / ROW_DIFF_PAGE_SIZE));
  const safePage = useCache ? Math.min(page, totalPages - 1) : inlineSafePage;

  useEffect(() => {
    if (safePage !== page) {
      setPage(safePage);
    }
  }, [safePage, page]);

  const showingFrom = displayTotalRows === 0 ? 0 : safePage * ROW_DIFF_PAGE_SIZE + 1;
  const showingTo = Math.min((safePage + 1) * ROW_DIFF_PAGE_SIZE, displayTotalRows);

  const toggleKindFilter = useCallback((kind: RowDiffKind) => {
    setKindFilters((prev) =>
      prev.includes(kind) ? prev.filter((item) => item !== kind) : [...prev, kind],
    );
    setPage(0);
  }, []);

  if (!analysis || analysis.status === "unchecked") {
    return (
      <div className="db-toolbox-row-diff-panel db-toolbox-row-diff-panel--empty">
        {t("database.toolbox.side.rowDiffPending")}
      </div>
    );
  }

  if (analysis.status === "analyzing") {
    return (
      <div className="db-toolbox-row-diff-panel db-toolbox-row-diff-panel--loading">
        <DataLoading total={1} current={0} message={t("database.toolbox.side.analysisAnalyzing")} />
      </div>
    );
  }

  if (analysis.status === "error") {
    return (
      <div className="db-toolbox-row-diff-panel db-toolbox-row-diff-panel--error">
        {analysis.error ?? t("database.toolbox.side.analysisError")}
      </div>
    );
  }

  if (pageError) {
    return (
      <div className="db-toolbox-row-diff-panel db-toolbox-row-diff-panel--error">
        {pageError}
      </div>
    );
  }

  const hasAnyDiff =
    analysis.status === "diff" &&
    ((analysis.diffRows ?? 0) > 0 || (analysis.diffs?.length ?? 0) > 0);

  if (analysis.status === "match" || !hasAnyDiff) {
    return (
      <div className="db-toolbox-row-diff-panel db-toolbox-row-diff-panel--empty">
        {t("database.toolbox.side.rowDiffNoDetail", { table: tableName })}
      </div>
    );
  }

  if (analysis.truncated && !cacheId) {
    return (
      <div className="db-toolbox-row-diff-panel db-toolbox-row-diff-panel--empty">
        {t("database.toolbox.side.rowDiffCacheMissing")}
      </div>
    );
  }

  const columnNames = columns.map((col) => col.name);

  return (
    <div className="db-toolbox-row-diff-panel">
      <div className="db-toolbox-row-diff-panel__toolbar">
        <fieldset className="db-toolbox-row-diff-kind-filters">
          <legend className="db-toolbox-row-diff-kind-filters__legend">
            {t("database.toolbox.side.rowDiffKindFilter")}
          </legend>
          {ALL_ROW_DIFF_KINDS.map((kind) => (
            <label key={kind} className="db-toolbox-row-diff-kind-check">
              <input
                type="checkbox"
                checked={kindFilters.includes(kind)}
                onChange={() => toggleKindFilter(kind)}
              />
              <span className={`db-toolbox-row-diff-kind db-toolbox-row-diff-kind--${kind}`}>
                {rowDiffKindLabel(kind, t)}
              </span>
            </label>
          ))}
        </fieldset>
      </div>

      {pageLoading ? (
        <div className="db-toolbox-row-diff-panel db-toolbox-row-diff-panel--loading">
          <DataLoading total={1} current={0} message={t("database.toolbox.side.rowDiffLoadingPage")} />
        </div>
      ) : displayTotalRows === 0 ? (
        <div className="db-toolbox-row-diff-panel db-toolbox-row-diff-panel--empty db-toolbox-row-diff-panel__filter-empty">
          {t("database.toolbox.side.rowDiffKindFilterNoMatch")}
        </div>
      ) : (
        <>
          <div className="db-toolbox-row-diff-scroll">
            <table className="db-toolbox-row-diff-table">
              <thead>
                <tr>
                  <th>{t("database.toolbox.side.rowDiffKey")}</th>
                  <th>{t("database.toolbox.side.rowDiffKind")}</th>
                  {columnNames.map((name) => (
                    <th key={name}>{name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayDiffs.map((diff) => {
                  const kindLabel = rowDiffKindLabel(diff.kind, t);

                  return (
                    <tr
                      key={diff.rowKey}
                      className={`db-toolbox-row-diff-row db-toolbox-row-diff-row--${diff.kind}`}
                    >
                      <td className="db-toolbox-row-diff-key">{diff.displayKey}</td>
                      <td>
                        <span className={`db-toolbox-row-diff-kind db-toolbox-row-diff-kind--${diff.kind}`}>
                          {kindLabel}
                        </span>
                      </td>
                      {columnNames.map((colName) => {
                        const isChanged = diff.changedFields?.includes(colName) ?? false;
                        const sourceVal = diff.sourceRow?.[colName];
                        const targetVal = diff.targetRow?.[colName];
                        let cellText: string;
                        if (diff.kind === "changed" && isChanged) {
                          cellText = `${formatCellValue(sourceVal)} → ${formatCellValue(targetVal)}`;
                        } else if (diff.kind === "sourceOnly") {
                          cellText = formatCellValue(sourceVal);
                        } else if (diff.kind === "targetOnly") {
                          cellText = formatCellValue(targetVal);
                        } else {
                          cellText = formatCellValue(sourceVal ?? targetVal);
                        }

                        return (
                          <td
                            key={colName}
                            className={isChanged ? "db-toolbox-row-diff-cell--conflict" : undefined}
                            title={cellText}
                          >
                            {cellText}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="db-pagination db-toolbox-row-diff-pagination">
            <div className="db-pagination-info">
              <span>
                {t("database.toolbox.side.rowDiffPageInfo", {
                  from: showingFrom.toLocaleString(),
                  to: showingTo.toLocaleString(),
                  total: displayTotalRows.toLocaleString(),
                })}
              </span>
            </div>
            <div className="db-pagination-controls">
              <Button
                variant="ghost"
                size="sm"
                disabled={safePage <= 0 || pageLoading}
                onClick={() => setPage(0)}
                title={t("database.results.paginationFirst")}
                aria-label={t("database.results.paginationFirst")}
              >
                «
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={safePage <= 0 || pageLoading}
                onClick={() => setPage((prev) => Math.max(0, prev - 1))}
                title={t("database.results.paginationPrev")}
                aria-label={t("database.results.paginationPrev")}
              >
                ‹
              </Button>
              <span className="db-pagination-pages">
                {safePage + 1} / {totalPages}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={safePage >= totalPages - 1 || pageLoading}
                onClick={() => setPage((prev) => Math.min(totalPages - 1, prev + 1))}
                title={t("database.results.paginationNext")}
                aria-label={t("database.results.paginationNext")}
              >
                ›
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={safePage >= totalPages - 1 || pageLoading}
                onClick={() => setPage(totalPages - 1)}
                title={t("database.results.paginationLast")}
                aria-label={t("database.results.paginationLast")}
              >
                »
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
