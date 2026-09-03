import { useEffect, useMemo, useState } from "react";
import type { CloudLogEntry, CloudLogPage } from "../../ipc/bindings";
import { useI18n } from "../../i18n";
import { Button } from "../../components/ui/primitives/Button";
import { FormDialog } from "../../components/ui/form/FormDialog";
import { Select } from "../../components/ui/form/Select";
import { TextInput } from "../../components/ui/form/TextInput";
import { CloudPager } from "./CloudListPager";
import { CLOUD_LOG_DEFAULT_PAGE_SIZE, CLOUD_LOG_PAGE_SIZES } from "./cloudPaging";
import { toCsv } from "../database/shared/csvExport";
import { copyCloudText } from "./cloudDetailUi";
import { showToast } from "../../stores/toastStore";
import {
  CLOUD_LOG_CSV_COLUMNS,
  CLOUD_LOG_RANGE_PRESETS,
  cloudLogCsvRows,
  filterCloudLogEntries,
  sortCloudLogEntries,
  type CloudLogRangeId,
  type CloudLogSortDir,
  type CloudLogSortKey,
} from "./cloudLogQuery";
import type { CloudMetricRangeId } from "./cloudMetricChart";

function formatTs(ms: number | undefined): string {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "—";
  }
}

function downloadCsv(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function CloudSlowLogPanel({
  page,
  pageSize = CLOUD_LOG_DEFAULT_PAGE_SIZE,
  loading,
  error,
  rangeId,
  customStart,
  customEnd,
  dbName,
  dbNames,
  sortKey,
  sortDir,
  onRangeChange,
  onCustomChange,
  onSortChange,
  onApplyQuery,
  onRefresh,
  onPageChange,
  onPageSizeChange,
}: {
  page: CloudLogPage | null;
  pageSize?: number;
  loading?: boolean;
  error?: string | null;
  rangeId: CloudLogRangeId;
  customStart: string;
  customEnd: string;
  dbName: string;
  dbNames: string[];
  sortKey: CloudLogSortKey;
  sortDir: CloudLogSortDir;
  onRangeChange: (id: CloudMetricRangeId) => void;
  onCustomChange: (start: string, end: string) => void;
  onSortChange: (key: CloudLogSortKey, dir: CloudLogSortDir) => void;
  onApplyQuery: (filters: { dbName: string; minDuration: string; keyword: string }) => void;
  onRefresh: () => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  const { t } = useI18n();
  const [draftDbName, setDraftDbName] = useState(dbName);
  const [minDuration, setMinDuration] = useState("");
  const [sqlContains, setSqlContains] = useState("");
  const [appliedMinDuration, setAppliedMinDuration] = useState("");
  const [appliedKeyword, setAppliedKeyword] = useState("");
  const [detail, setDetail] = useState<CloudLogEntry | null>(null);

  useEffect(() => {
    setDraftDbName(dbName);
  }, [dbName]);

  const rawEntries: CloudLogEntry[] = page?.entries ?? [];
  const entries = useMemo(
    () =>
      sortCloudLogEntries(
        filterCloudLogEntries(rawEntries, appliedMinDuration, appliedKeyword),
        sortKey,
        sortDir,
      ),
    [appliedKeyword, appliedMinDuration, rawEntries, sortDir, sortKey],
  );
  const currentPage = page?.page && page.page > 0 ? page.page : 1;
  const total = page?.total ?? rawEntries.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize) || 1);
  const from = total === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const to = Math.min(currentPage * pageSize, total);
  const pageFiltered = appliedMinDuration.trim() !== "" || appliedKeyword.trim() !== "";
  const detailSql = detail?.fields?.sql || detail?.summary || "";

  const toggleSort = (key: CloudLogSortKey) => {
    if (sortKey === key) {
      onSortChange(key, sortDir === "desc" ? "asc" : "desc");
      return;
    }
    onSortChange(key, "desc");
  };

  const sortMark = (key: CloudLogSortKey) => {
    if (sortKey !== key) return "";
    return sortDir === "asc" ? " ↑" : " ↓";
  };

  const applyQuery = () => {
    setAppliedMinDuration(minDuration);
    setAppliedKeyword(sqlContains);
    onApplyQuery({ dbName: draftDbName, minDuration, keyword: sqlContains });
  };

  const exportCsv = () => {
    if (entries.length === 0) {
      showToast(t("cloud.logs.exportEmpty"));
      return;
    }
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    downloadCsv(
      `slow-logs-${stamp}.csv`,
      toCsv([...CLOUD_LOG_CSV_COLUMNS], cloudLogCsvRows(entries), {
        header: [
          t("cloud.logs.time"),
          t("cloud.logs.duration"),
          t("cloud.logs.host"),
          t("cloud.logs.db"),
          t("cloud.logs.sql"),
        ],
      }),
    );
  };

  return (
    <div className="cloud-logs cloud-panel-card">
      <div className="cloud-panel-card__head">
        <h3 className="cloud-panel-card__title" title={t("cloud.logs.rangeHint")}>
          {t("cloud.detail.slots.logs")}
        </h3>
        <div className="cloud-logs__toolbar">
          <span className="cloud-chip">
            {pageFiltered
              ? t("cloud.logs.pageFilter", {
                  shown: String(entries.length),
                  total: String(rawEntries.length),
                })
              : t("cloud.logs.count", { count: String(page?.total ?? rawEntries.length) })}
          </span>
          <Button type="button" size="sm" variant="ghost" disabled={loading || entries.length === 0} onClick={exportCsv}>
            {t("cloud.logs.exportCsv")}
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={loading} onClick={onRefresh}>
            {loading ? t("server.refreshing") : t("server.refresh")}
          </Button>
        </div>
      </div>
      <div className="cloud-logs__filters">
        <div className="cloud-metrics__ranges" title={t("cloud.logs.rangeHint")}>
          {CLOUD_LOG_RANGE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`cloud-metrics__range${rangeId === preset.id ? " is-active" : ""}`}
              disabled={loading}
              onClick={() => onRangeChange(preset.id)}
            >
              {t(`cloud.metrics.range.${preset.id}`)}
            </button>
          ))}
        </div>
        <label className="cloud-logs__field">
          <span>{t("cloud.logs.from")}</span>
          <input
            type="datetime-local"
            className="input input-sm"
            value={customStart}
            disabled={loading}
            onChange={(event) => onCustomChange(event.target.value, customEnd)}
          />
        </label>
        <label className="cloud-logs__field">
          <span>{t("cloud.logs.to")}</span>
          <input
            type="datetime-local"
            className="input input-sm"
            value={customEnd}
            min={customStart || undefined}
            disabled={loading}
            onChange={(event) => onCustomChange(customStart, event.target.value)}
          />
        </label>
        <label className="cloud-logs__field">
          <span>{t("cloud.logs.db")}</span>
          <Select
            size="sm"
            searchable
            allowCustom
            disabled={loading}
            value={draftDbName}
            placeholder={t("cloud.logs.dbAll")}
            searchPlaceholder={t("cloud.logs.db")}
            panelMinWidth={180}
            options={[
              { value: "", label: t("cloud.logs.dbAll") },
              ...dbNames.map((name) => ({ value: name, label: name })),
            ]}
            onChange={setDraftDbName}
          />
        </label>
        <label className="cloud-logs__field cloud-logs__field--duration">
          <span>{t("cloud.logs.minDuration")}</span>
          <TextInput
            size="sm"
            inputMode="decimal"
            placeholder={t("cloud.logs.minDurationHint")}
            value={minDuration}
            clearable={false}
            copyable={false}
            style={{ width: 72 }}
            onChange={setMinDuration}
            onKeyDown={(event) => {
              if (event.key === "Enter") applyQuery();
            }}
          />
        </label>
        <label className="cloud-logs__field cloud-logs__field--grow">
          <span>{t("cloud.logs.sqlContains")}</span>
          <TextInput
            size="sm"
            value={sqlContains}
            placeholder={t("cloud.logs.sqlPlaceholder")}
            clearable
            copyable={false}
            onChange={setSqlContains}
            onKeyDown={(event) => {
              if (event.key === "Enter") applyQuery();
            }}
          />
        </label>
        <Button type="button" size="sm" variant="outline" disabled={loading} onClick={applyQuery}>
          {t("cloud.logs.apply")}
        </Button>
      </div>
      {error ? <p className="cloud-metrics__error">{error}</p> : null}
      <div className="cloud-table-wrap">
        {entries.length === 0 && !loading && !error ? (
          <div className="cloud-empty">
            <strong>{pageFiltered ? t("cloud.logs.filterEmpty") : t("cloud.logs.empty")}</strong>
          </div>
        ) : (
          <table className="cloud-table">
            <thead>
              <tr>
                <th>
                  <button type="button" className="cloud-logs__sort" onClick={() => toggleSort("time")}>
                    {t("cloud.logs.time")}
                    {sortMark("time")}
                  </button>
                </th>
                <th>
                  <button type="button" className="cloud-logs__sort" onClick={() => toggleSort("duration")}>
                    {t("cloud.logs.duration")}
                    {sortMark("duration")}
                  </button>
                </th>
                <th>{t("cloud.logs.host")}</th>
                <th>{t("cloud.logs.db")}</th>
                <th>{t("cloud.logs.sql")}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, index) => (
                <tr
                  key={`${entry.id || "log"}-${entry.tsMs ?? 0}-${index}`}
                  className="cloud-logs__row"
                  onDoubleClick={() => setDetail(entry)}
                >
                  <td>{formatTs(entry.tsMs)}</td>
                  <td>{entry.fields?.queryTimes || "—"}</td>
                  <td>{entry.fields?.host || "—"}</td>
                  <td>{entry.fields?.db || "—"}</td>
                  <td title={entry.fields?.sql || entry.summary} className="cloud-logs__sql">
                    {entry.summary || entry.fields?.sql || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <CloudPager
        page={currentPage}
        pageSize={pageSize}
        total={total}
        totalPages={totalPages}
        from={from}
        to={to}
        disabled={loading}
        always
        pageSizes={CLOUD_LOG_PAGE_SIZES}
        onPageChange={onPageChange}
        onPageSizeChange={onPageSizeChange}
      />

      <FormDialog
        open={detail != null}
        onClose={() => setDetail(null)}
        title={t("cloud.logs.sqlDetail")}
        size="lg"
        cancelLabel={t("common.close")}
        actions={[
          {
            key: "copy",
            label: t("common.copy"),
            onClick: () => {
              void copyCloudText(detailSql).then((ok) => {
                if (ok) showToast(t("common.copied"));
              });
            },
          },
        ]}
      >
        {detail ? (
          <div className="cloud-logs-dialog">
            <dl className="cloud-logs-dialog__meta">
              <div>
                <dt>{t("cloud.logs.time")}</dt>
                <dd>{formatTs(detail.tsMs)}</dd>
              </div>
              <div>
                <dt>{t("cloud.logs.duration")}</dt>
                <dd>{detail.fields?.queryTimes || "—"}</dd>
              </div>
              <div>
                <dt>{t("cloud.logs.host")}</dt>
                <dd>{detail.fields?.host || "—"}</dd>
              </div>
              <div>
                <dt>{t("cloud.logs.db")}</dt>
                <dd>{detail.fields?.db || "—"}</dd>
              </div>
            </dl>
            <pre className="cloud-logs-dialog__sql">{detailSql || "—"}</pre>
          </div>
        ) : null}
      </FormDialog>
    </div>
  );
}
