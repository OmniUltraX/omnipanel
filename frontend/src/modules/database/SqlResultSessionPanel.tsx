import { memo, useCallback, useMemo } from "react";
import { useSettingsStore } from "../../stores/settingsStore";
import { useDbWorkspace } from "../../contexts/DbWorkspaceContext";
import { Button } from "../../components/ui/Button";
import { TableDataGrid } from "./TableDataGrid";
import { useI18n } from "../../i18n";
import { estimateSqlResultTotalRows, type SqlResultSession } from "./dbWorkspaceState";

interface SqlResultSessionPanelProps {
  sqlTabId: string;
  session: SqlResultSession;
}

function SqlResultSessionFooterExtra({
  session,
  sqlTabId,
  canExport,
  resultHasMore,
  estimatedTotalRows,
}: {
  session: SqlResultSession;
  sqlTabId: string;
  canExport: boolean;
  resultHasMore: boolean;
  estimatedTotalRows: number;
}) {
  const { t } = useI18n();
  const ws = useDbWorkspace();

  if (session.running) return null;

  return (
    <>
      {canExport ? (
        <Button
          variant="icon"
          title={t("database.results.exportCsv")}
          aria-label={t("database.results.exportCsv")}
          disabled={session.running}
          onClick={(e) => {
            ws.openExportMenu(e.clientX, e.clientY, sqlTabId, session.id);
          }}
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            width="14"
            height="14"
            aria-hidden
          >
            <path d="M8 1.5v9" strokeLinecap="round" />
            <path d="M4.5 7L8 10.5 11.5 7" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M2.5 13h11" strokeLinecap="round" />
          </svg>
        </Button>
      ) : null}
      {session.result || session.error ? (
        <span className="results-meta">
          {t("database.results.meta", {
            rows: resultHasMore ? `${estimatedTotalRows}+` : estimatedTotalRows,
            ms: session.elapsed ?? 0,
            mode: t("common.readonly"),
          })}
          {resultHasMore ? (
            <span className="db-exec-stats-truncated">
              {" · "}
              {t("database.results.hasMore")}
            </span>
          ) : null}
        </span>
      ) : null}
    </>
  );
}

export const SqlResultSessionPanel = memo(function SqlResultSessionPanel({
  sqlTabId,
  session,
}: SqlResultSessionPanelProps) {
  const { t } = useI18n();
  const ws = useDbWorkspace();
  const databaseQueryPageSize = useSettingsStore((s) => s.databaseQueryPageSize);

  const resultRows = session.result
    ? ws.rowsToRecord(session.result.columns, session.result.rows)
    : [];
  const rowCount = resultRows.length;

  const resultPage = session.resultPage ?? 0;
  const resultHasMore = session.resultHasMore ?? false;
  const estimatedTotalRows = estimateSqlResultTotalRows(
    resultPage,
    databaseQueryPageSize,
    rowCount,
    resultHasMore,
  );

  const hasSqlResult = !!(session.result && session.result.columns.length > 0);
  const canExport = hasSqlResult;

  const handleQueryPageChange = useCallback(
    (page: number) => void ws.goToQueryResultPage(sqlTabId, page, session.id),
    [ws.goToQueryResultPage, sqlTabId, session.id],
  );

  const sqlPreview = useMemo(() => {
    const compact = session.sql.replace(/\s+/g, " ").trim();
    return compact.length > 120 ? `${compact.slice(0, 120)}…` : compact;
  }, [session.sql]);

  const footerExtra = useMemo(
    () => (
      <SqlResultSessionFooterExtra
        session={session}
        sqlTabId={sqlTabId}
        canExport={canExport}
        resultHasMore={resultHasMore}
        estimatedTotalRows={estimatedTotalRows}
      />
    ),
    [session, sqlTabId, canExport, resultHasMore, estimatedTotalRows],
  );

  const showStandaloneFooter =
    !session.running &&
    (session.error != null || (session.result != null && session.result.columns.length === 0));

  return (
    <div className="db-sql-result-session">
      {sqlPreview ? (
        <div className="db-sql-result-query" title={session.sql}>
          {sqlPreview}
        </div>
      ) : null}
      {session.running ? (
        <div className="empty-state compact" style={{ padding: "var(--sp-4)" }}>
          {t("database.running")}
        </div>
      ) : session.error ? (
        <div
          className="empty-state compact text-danger"
          style={{ padding: "var(--sp-4)", whiteSpace: "pre-wrap" }}
        >
          {session.error}
        </div>
      ) : session.result ? (
        session.result.columns.length === 0 ? (
          <div className="empty-state compact" style={{ padding: "var(--sp-4)" }}>
            {t("database.results.affected", { rows: session.result.rowsAffected })}
          </div>
        ) : (
          <TableDataGrid
            columns={session.result.columns}
            rows={resultRows}
            totalRows={estimatedTotalRows}
            page={resultPage}
            pageSize={databaseQueryPageSize}
            loading={session.running}
            onPageChange={handleQueryPageChange}
            footerExtra={footerExtra}
          />
        )
      ) : (
        <div className="empty-state compact" style={{ padding: "var(--sp-4)" }}>
          {t("database.results.runHint")}
        </div>
      )}
      {showStandaloneFooter ? (
        <div className="db-pagination db-sql-results-footer">
          <div className="db-pagination-extra">{footerExtra}</div>
        </div>
      ) : null}
    </div>
  );
});
