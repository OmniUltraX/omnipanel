import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../../../components/ui/Button";
import { useI18n } from "../../../i18n";
import { DataLoading } from "../../../components/ui/DataLoading";
import type { DbColumnMeta, DbConnectionConfig } from "../api";
import { fetchAllTableRowDiffs } from "./rowDiff";
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

function needsFullDiffFetch(analysis: DataAnalysisResult): boolean {
  const previewCount = analysis.diffs?.length ?? 0;
  const total = analysis.diffRows ?? previewCount;
  return Boolean(analysis.truncated) || total > previewCount;
}

export function TableRowDiffPanel({
  tableName,
  analysis,
  columns,
  sourceConn,
  targetConn,
}: {
  tableName: string;
  analysis?: DataAnalysisResult;
  columns: DbColumnMeta[];
  sourceConn?: DbConnectionConfig;
  targetConn?: DbConnectionConfig;
}) {
  const { t } = useI18n();
  const [page, setPage] = useState(0);
  const [kindFilters, setKindFilters] = useState<RowDiffKind[]>(ALL_ROW_DIFF_KINDS);
  const [fullDiffs, setFullDiffs] = useState<TableRowDiff[] | null>(null);
  const [fullDiffsLoading, setFullDiffsLoading] = useState(false);
  const [fullDiffsError, setFullDiffsError] = useState<string | null>(null);

  useEffect(() => {
    setPage(0);
    setKindFilters(ALL_ROW_DIFF_KINDS);
    setFullDiffs(null);
    setFullDiffsError(null);
    setFullDiffsLoading(false);
  }, [tableName, analysis?.diffs, analysis?.diffRows, analysis?.truncated]);

  const columnKey = useMemo(() => columns.map((col) => col.name).join("\0"), [columns]);

  const shouldFetchAll = useMemo(
    () =>
      analysis?.status === "diff" &&
      needsFullDiffFetch(analysis) &&
      Boolean(sourceConn && targetConn && columns.length > 0),
    [analysis, sourceConn, targetConn, columns.length],
  );

  useEffect(() => {
    if (!shouldFetchAll || !sourceConn || !targetConn || columns.length === 0) {
      setFullDiffsLoading(false);
      return;
    }

    let cancelled = false;
    setFullDiffsLoading(true);
    setFullDiffsError(null);

    void fetchAllTableRowDiffs(sourceConn, targetConn, tableName, columns)
      .then((result) => {
        if (cancelled) return;
        if (result.status === "match") {
          setFullDiffs([]);
          return;
        }
        setFullDiffs(result.diffs);
      })
      .catch((error) => {
        if (cancelled) return;
        setFullDiffsError(String(error));
        setFullDiffs(null);
      })
      .finally(() => {
        if (!cancelled) {
          setFullDiffsLoading(false);
        }
      });

    return () => {
      cancelled = true;
      setFullDiffsLoading(false);
    };
  }, [shouldFetchAll, sourceConn, targetConn, tableName, columnKey, columns]);

  const allDiffs = useMemo(() => {
    if (analysis?.status !== "diff") {
      return [];
    }
    if (fullDiffs !== null) {
      return fullDiffs;
    }
    if (shouldFetchAll) {
      return [];
    }
    return analysis.diffs ?? [];
  }, [analysis, fullDiffs, shouldFetchAll]);

  const filteredDiffs = useMemo(() => {
    if (kindFilters.length === 0) {
      return [];
    }
    if (kindFilters.length >= ALL_ROW_DIFF_KINDS.length) {
      return allDiffs;
    }
    const allowed = new Set(kindFilters);
    return allDiffs.filter((diff) => allowed.has(diff.kind));
  }, [allDiffs, kindFilters]);

  const totalRows = filteredDiffs.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / ROW_DIFF_PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);

  useEffect(() => {
    if (safePage !== page) {
      setPage(safePage);
    }
  }, [safePage, page]);

  const pageDiffs = useMemo(() => {
    const start = safePage * ROW_DIFF_PAGE_SIZE;
    return filteredDiffs.slice(start, start + ROW_DIFF_PAGE_SIZE);
  }, [filteredDiffs, safePage]);

  const showingFrom = totalRows === 0 ? 0 : safePage * ROW_DIFF_PAGE_SIZE + 1;
  const showingTo = Math.min((safePage + 1) * ROW_DIFF_PAGE_SIZE, totalRows);

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

  if (analysis.status === "analyzing" || fullDiffsLoading) {
    return (
      <div className="db-toolbox-row-diff-panel db-toolbox-row-diff-panel--loading">
        <DataLoading
          total={1}
          current={0}
          message={
            fullDiffsLoading
              ? t("database.toolbox.side.rowDiffLoadingAll")
              : t("database.toolbox.side.analysisAnalyzing")
          }
        />
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

  if (fullDiffsError) {
    return (
      <div className="db-toolbox-row-diff-panel db-toolbox-row-diff-panel--error">
        {fullDiffsError}
      </div>
    );
  }

  if (analysis.status === "match" || allDiffs.length === 0) {
    return (
      <div className="db-toolbox-row-diff-panel db-toolbox-row-diff-panel--empty">
        {t("database.toolbox.side.rowDiffNoDetail", { table: tableName })}
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

      {filteredDiffs.length === 0 ? (
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
                {pageDiffs.map((diff) => {
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
                  total: totalRows.toLocaleString(),
                })}
              </span>
            </div>
            <div className="db-pagination-controls">
              <Button
                variant="ghost"
                size="sm"
                disabled={safePage <= 0}
                onClick={() => setPage(0)}
                title={t("database.results.paginationFirst")}
                aria-label={t("database.results.paginationFirst")}
              >
                «
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={safePage <= 0}
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
                disabled={safePage >= totalPages - 1}
                onClick={() => setPage((prev) => Math.min(totalPages - 1, prev + 1))}
                title={t("database.results.paginationNext")}
                aria-label={t("database.results.paginationNext")}
              >
                ›
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={safePage >= totalPages - 1}
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
