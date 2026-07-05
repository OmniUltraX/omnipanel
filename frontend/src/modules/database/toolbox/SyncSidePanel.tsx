import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Button } from "../../../components/ui/primitives/Button";
import { MultiSelect } from "../../../components/ui/form/MultiSelect";
import { useI18n } from "../../../i18n";
import { DataLoading, type DataLoadingProps } from "../../../components/ui/feedback/DataLoading";
import { Select } from "../../../components/ui/form/Select";
import { TextInput } from "../../../components/ui/form/TextInput";
import type { DbColumnMeta, DbConnectionConfig, DbIndexMeta } from "../api";
import type {
  DataAnalysisResult,
  DataSyncStrategy,
  SyncSideSnapshot,
  SyncTableInfo,
  TableTargetStatus,
  ToolboxTabId,
  SchemaTargetRowStatus,
} from "./types";
import {
  ALL_SCHEMA_TARGET_ROW_STATUSES,
  isSchemaTargetStatusFilterShowAll,
} from "./types";
import type { SchemaColumnDiff, SchemaIndexDiff, SchemaTableDiff } from "./schemaDiff";
import {
  filterAlignedTableNamesByStatus,
  findTableByName,
  isSchemaCaseSensitive,
  tableNameExistsInSet,
} from "./schemaSyncAlignedTables";

/** 源侧完整表列表；目标侧仅展示源库已选表的同步状态 */
export type SyncTableListMode = "source" | "targetSync";

interface SyncSidePanelProps {
  sideLabel: string;
  tableListMode?: SyncTableListMode;
  connections: DbConnectionConfig[];
  connectionId: string;
  database: string;
  onConnectionChange: (id: string) => void;
  onDatabaseChange: (db: string) => void;
  databases: string[];
  databasesLoading: boolean;
  snapshot: SyncSideSnapshot;
  /** 加载中时传入 DataLoading 的进度参数 */
  loadingProgress?: Pick<DataLoadingProps, "total" | "current" | "message">;
  tab: ToolboxTabId;
  expandedTables: Set<string>;
  onToggleTable: (tableName: string) => void;
  selectedTables: Set<string>;
  onToggleSelect: (tableName: string) => void;
  onSelectAllTables: (tableNames: string[], selected: boolean) => void;
  /** 正在统计行数的表名 */
  countingTables?: Set<string>;
  /** 目标同步列表：源侧已勾选的表名（有序） */
  sourceSelectedTableNames?: string[];
  targetConfigured?: boolean;
  targetTablesLoading?: boolean;
  tableTargetStatus?: Record<string, TableTargetStatus>;
  tableSyncStrategies?: Record<string, DataSyncStrategy>;
  onSyncStrategyChange?: (tableName: string, strategy: DataSyncStrategy) => void;
  /** 结构同步：源表与目标表的字段差异 */
  schemaTableDiffs?: Record<string, SchemaTableDiff>;
  /** 数据同步：逐条比对结果（行级 diff） */
  tableAnalysis?: Record<string, DataAnalysisResult>;
  /** 当前打开冲突详情的表名（用于 tag 高亮） */
  conflictDetailTable?: string | null;
  /** 点击冲突 / 差异 tag 时打开详情 */
  onViewConflictDetail?: (tableName: string) => void;
  /** 结构同步目标侧：是否显示字段一致的表（已废弃，由 schemaStatusFilter 替代） */
  showMatchingTables?: boolean;
  onShowMatchingTablesChange?: (value: boolean) => void;
  /** 结构同步目标侧：表状态筛选（空数组表示全部） */
  schemaStatusFilters?: SchemaTargetRowStatus[];
  onSchemaStatusFiltersChange?: (value: SchemaTargetRowStatus[]) => void;
  /** 结构同步目标侧：源表字段（用于展开展示） */
  sourceTableColumns?: Record<string, DbColumnMeta[]>;
  /** 结构同步目标侧：源表索引（用于展开展示） */
  sourceTableIndexes?: Record<string, DbIndexMeta[]>;
  /** 结构同步：两侧对齐后的表名列表（统一顺序） */
  alignedTableNames?: string[];
  /** 结构同步：目标侧完整 schema 快照 */
  targetSnapshot?: SyncSideSnapshot;
  /** 结构同步：表搜索（由父级同步到两侧） */
  schemaTableSearch?: string;
  onSchemaTableSearchChange?: (value: string) => void;
  /** 结构同步：源库表名集合（目标侧判断占位用） */
  sourceTableNames?: Set<string>;
  /** 结构同步：比较表名是否区分大小写 */
  schemaCaseSensitive?: boolean;
  /** 结构同步：列表滚动容器 ref（用于同步滚动） */
  scrollListRef?: RefObject<HTMLDivElement | null>;
  /** 目标侧：手动分析 / 重新分析 */
  onAnalyze?: () => void;
  analyzeBusy?: boolean;
  hasAnalysisResult?: boolean;
}

function TableSelectCheckbox({
  tableName,
  checked,
  onToggle,
}: {
  tableName: string;
  checked: boolean;
  onToggle: (tableName: string) => void;
}) {
  const { t } = useI18n();

  return (
    <label
      className="db-toolbox-table-check"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={() => onToggle(tableName)}
        aria-label={tableName}
        title={t("database.toolbox.side.selectTable", { table: tableName })}
      />
    </label>
  );
}

function ConnectionDatabaseFilters({
  connections,
  connectionId,
  database,
  onConnectionChange,
  onDatabaseChange,
  databases,
  databasesLoading,
  showSelectAll,
  selectAllRef,
  allVisibleSelected,
  visibleNames,
  onSelectAllTables,
  search,
  onSearchChange,
  onSearchKeyDown,
  searchPlaceholder,
  toolbarLayout = "default",
  showMatchingTables,
  onShowMatchingTablesChange,
  schemaStatusFilters,
  onSchemaStatusFiltersChange,
  onAnalyze,
  analyzeBusy,
  hasAnalysisResult,
}: {
  connections: DbConnectionConfig[];
  connectionId: string;
  database: string;
  onConnectionChange: (id: string) => void;
  onDatabaseChange: (db: string) => void;
  databases: string[];
  databasesLoading: boolean;
  showSelectAll: boolean;
  selectAllRef: RefObject<HTMLInputElement | null>;
  allVisibleSelected: boolean;
  visibleNames: string[];
  onSelectAllTables: (tableNames: string[], selected: boolean) => void;
  search?: string;
  onSearchChange?: (value: string) => void;
  onSearchKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  searchPlaceholder?: string;
  toolbarLayout?: "default" | "sourceRow" | "targetRow";
  showMatchingTables?: boolean;
  onShowMatchingTablesChange?: (value: boolean) => void;
  schemaStatusFilters?: SchemaTargetRowStatus[];
  onSchemaStatusFiltersChange?: (value: SchemaTargetRowStatus[]) => void;
  onAnalyze?: () => void;
  analyzeBusy?: boolean;
  hasAnalysisResult?: boolean;
}) {
  const { t } = useI18n();
  const conn = useMemo(
    () => connections.find((c) => c.id === connectionId) ?? null,
    [connections, connectionId],
  );
  const filtersClassName =
    toolbarLayout === "sourceRow"
      ? "db-toolbox-side__filters db-toolbox-side__filters--source-row"
      : toolbarLayout === "targetRow"
        ? "db-toolbox-side__filters db-toolbox-side__filters--target-row"
        : "db-toolbox-side__filters";

  return (
    <div className={filtersClassName}>
      <Select
        className="db-select"
        value={connectionId}
        onChange={onConnectionChange}
        disabled={connections.length === 0}
        title={t("database.toolbox.side.connection")}
        placeholder={t("database.toolbox.side.noConnection")}
        options={
          connections.length === 0
            ? [{ value: "", label: t("database.toolbox.side.noConnection"), disabled: true }]
            : connections.map((c) => ({ value: c.id, label: c.name }))
        }
      />
      <Select
        className="db-select"
        value={database}
        onChange={onDatabaseChange}
        disabled={!conn || databasesLoading || databases.length === 0}
        title={t("database.toolbox.side.database")}
        placeholder={t("database.toolbox.side.noDatabase")}
        options={
          !conn || databases.length === 0
            ? [{ value: "", label: t("database.toolbox.side.noDatabase"), disabled: true }]
            : databases.map((dbName) => ({ value: dbName, label: dbName }))
        }
      />
      {search !== undefined && onSearchChange && (
        <TextInput
          copyable={false}
          className="input db-toolbox-search"
          value={search}
          onChange={onSearchChange}
          onKeyDown={onSearchKeyDown}
          placeholder={searchPlaceholder ?? t("database.toolbox.side.searchTables")}
          aria-label={searchPlaceholder ?? t("database.toolbox.side.searchTables")}
        />
      )}
      {showSelectAll && (
        <label className="db-toolbox-select-all">
          <input
            ref={selectAllRef}
            type="checkbox"
            checked={allVisibleSelected}
            disabled={visibleNames.length === 0}
            onChange={() => onSelectAllTables(visibleNames, !allVisibleSelected)}
            aria-label={t("database.toolbox.side.selectAll")}
          />
          <span>{t("database.toolbox.side.selectAll")}</span>
        </label>
      )}
      {showMatchingTables !== undefined && onShowMatchingTablesChange && (
        <label
          className="db-toolbox-show-matching"
          onClick={(e) => {
            e.preventDefault();
            onShowMatchingTablesChange(!showMatchingTables);
          }}
        >
          <span>{t("database.toolbox.side.showMatchingTables")}</span>
          <div
            className={`toggle${showMatchingTables ? " on" : ""}`}
            role="switch"
            aria-checked={showMatchingTables}
            aria-label={t("database.toolbox.side.showMatchingTables")}
          />
        </label>
      )}
      {schemaStatusFilters !== undefined && onSchemaStatusFiltersChange && (
        <MultiSelect
          className="db-select db-toolbox-schema-status-filter"
          values={schemaStatusFilters}
          onChange={(values) =>
            onSchemaStatusFiltersChange(values as SchemaTargetRowStatus[])
          }
          allValues={ALL_SCHEMA_TARGET_ROW_STATUSES}
          placeholder={t("database.toolbox.side.schemaStatusFilterAll")}
          title={t("database.toolbox.side.schemaStatusFilter")}
          formatDisplayLabel={(labels, allSelected) =>
            allSelected
              ? t("database.toolbox.side.schemaStatusFilterAll")
              : labels.join("、")
          }
          options={[
            { value: "new", label: t("database.toolbox.side.tagNew") },
            { value: "diff", label: t("database.toolbox.side.schemaDiffChanged") },
            { value: "targetOnly", label: t("database.toolbox.side.schemaDiffTargetOnly") },
            { value: "match", label: t("database.toolbox.side.schemaDiffMatch") },
          ]}
        />
      )}
      {onAnalyze && (
        <div className="db-toolbox-reanalyze">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="db-toolbox-reanalyze__btn"
            disabled={analyzeBusy}
            onClick={onAnalyze}
          >
            {hasAnalysisResult
              ? t("database.toolbox.side.reanalyze")
              : t("database.toolbox.side.analyze")}
          </Button>
        </div>
      )}
    </div>
  );
}

function TableTargetTag({
  status,
  clickable,
  expanded,
  onClick,
}: {
  status: TableTargetStatus;
  clickable?: boolean;
  expanded?: boolean;
  onClick?: () => void;
}) {
  const { t } = useI18n();
  const label =
    status === "checking"
      ? t("database.toolbox.side.tagChecking")
      : status === "conflict"
        ? t("database.toolbox.side.tagConflict")
        : t("database.toolbox.side.tagNew");

  const className = [
    "db-toolbox-sync-tag",
    `db-toolbox-sync-tag--${status}`,
    clickable ? "db-toolbox-sync-tag--clickable" : "",
    expanded ? "db-toolbox-sync-tag--expanded" : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (clickable && onClick) {
    return (
      <button
        type="button"
        className={className}
        title={t("database.toolbox.side.viewConflictRows")}
        aria-expanded={expanded}
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
      >
        {label}
      </button>
    );
  }

  return (
    <span className={className} title={label}>
      {label}
    </span>
  );
}

const SYNC_STRATEGIES: DataSyncStrategy[] = ["rewrite", "append", "update"];

function SyncStrategyButtons({
  tableName,
  strategy,
  onChange,
}: {
  tableName: string;
  strategy: DataSyncStrategy;
  onChange?: (tableName: string, strategy: DataSyncStrategy) => void;
}) {
  const { t } = useI18n();

  const labels: Record<DataSyncStrategy, string> = {
    rewrite: t("database.toolbox.side.strategyRewrite"),
    append: t("database.toolbox.side.strategyAppend"),
    update: t("database.toolbox.side.strategyUpdate"),
  };
  const hints: Record<DataSyncStrategy, string> = {
    rewrite: t("database.toolbox.side.strategyRewriteHint"),
    append: t("database.toolbox.side.strategyAppendHint"),
    update: t("database.toolbox.side.strategyUpdateHint"),
  };

  return (
    <div
      className="db-toolbox-sync-strategies"
      role="group"
      aria-label={t("database.toolbox.side.tagConflict")}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {SYNC_STRATEGIES.map((mode) => (
        <button
          key={mode}
          type="button"
          className={`db-toolbox-sync-strategy${strategy === mode ? " active" : ""}`}
          aria-pressed={strategy === mode}
          title={hints[mode]}
          onClick={() => onChange?.(tableName, mode)}
        >
          {labels[mode]}
        </button>
      ))}
    </div>
  );
}

function TargetSyncTableRow({
  tableName,
  targetStatus,
  syncStrategy = "rewrite",
  onSyncStrategyChange,
  analysis,
  detailOpen = false,
  onViewConflictDetail,
}: {
  tableName: string;
  targetStatus?: TableTargetStatus;
  syncStrategy?: DataSyncStrategy;
  onSyncStrategyChange?: (tableName: string, strategy: DataSyncStrategy) => void;
  analysis?: DataAnalysisResult;
  detailOpen?: boolean;
  onViewConflictDetail?: (tableName: string) => void;
}) {
  const { t } = useI18n();
  const showStrategies = targetStatus === "conflict" && Boolean(onSyncStrategyChange);
  const analysisStatus = analysis?.status;
  const analysisLabel =
    analysisStatus === "analyzing"
      ? t("database.toolbox.side.analysisAnalyzing")
      : analysisStatus === "match"
        ? t("database.toolbox.side.analysisMatch")
        : analysisStatus === "diff"
          ? t("database.toolbox.side.analysisDiff", { count: analysis?.diffRows ?? 0 })
          : analysisStatus === "error"
            ? t("database.toolbox.side.analysisError")
            : null;
  const analysisTitle =
    analysisStatus === "error" && analysis?.error ? analysis.error : analysisLabel ?? undefined;

  const conflictClickable = targetStatus === "conflict" && Boolean(onViewConflictDetail);
  const diffClickable =
    (analysisStatus === "diff" || analysisStatus === "error") && Boolean(onViewConflictDetail);

  return (
    <li
      className={`db-toolbox-table-row db-toolbox-table-row--target db-toolbox-table-row--target-sync${showStrategies ? " db-toolbox-table-row--conflict" : ""}`}
    >
      <span className="db-toolbox-table-row__name">{tableName}</span>
      {targetStatus && (
        <TableTargetTag
          status={targetStatus}
          clickable={conflictClickable}
          expanded={detailOpen && conflictClickable}
          onClick={conflictClickable ? () => onViewConflictDetail?.(tableName) : undefined}
        />
      )}
      {analysisLabel && (
        diffClickable ? (
          <button
            type="button"
            className={`db-toolbox-sync-tag db-toolbox-analysis-tag db-toolbox-analysis-tag--${analysisStatus} db-toolbox-sync-tag--clickable${detailOpen ? " db-toolbox-sync-tag--expanded" : ""}`}
            title={analysisTitle}
            aria-expanded={detailOpen}
            onClick={(e) => {
              e.stopPropagation();
              onViewConflictDetail?.(tableName);
            }}
          >
            {analysisLabel}
          </button>
        ) : (
          <span
            className={`db-toolbox-sync-tag db-toolbox-analysis-tag db-toolbox-analysis-tag--${analysisStatus}`}
            title={analysisTitle}
          >
            {analysisLabel}
          </span>
        )
      )}
      {showStrategies && (
        <SyncStrategyButtons
          tableName={tableName}
          strategy={syncStrategy}
          onChange={onSyncStrategyChange}
        />
      )}
    </li>
  );
}

function SchemaDiffKindTag({ kind }: { kind: SchemaColumnDiff["kind"] }) {
  const { t } = useI18n();
  const label =
    kind === "added"
      ? t("database.toolbox.side.schemaDiffAdded")
      : kind === "removed"
        ? t("database.toolbox.side.schemaDiffRemoved")
        : t("database.toolbox.side.schemaDiffChanged");

  return (
    <span className={`db-toolbox-schema-diff-tag db-toolbox-schema-diff-tag--${kind}`}>
      {label}
    </span>
  );
}

function buildOrderedSchemaNames(
  sourceItems: { name: string }[],
  targetItems: { name: string }[],
): string[] {
  const sourceNames = sourceItems.map((item) => item.name);
  const sourceSet = new Set(sourceNames);
  const targetOnly = targetItems.filter((item) => !sourceSet.has(item.name)).map((item) => item.name);
  return [...sourceNames, ...targetOnly];
}

function SchemaTargetColumnList({
  sourceColumns,
  targetColumns,
  columnDiffs,
}: {
  sourceColumns: DbColumnMeta[];
  targetColumns: DbColumnMeta[];
  columnDiffs: SchemaColumnDiff[];
}) {
  const diffByName = useMemo(
    () => new Map(columnDiffs.map((d) => [d.name, d])),
    [columnDiffs],
  );
  const targetByName = useMemo(
    () => new Map(targetColumns.map((c) => [c.name, c])),
    [targetColumns],
  );
  const sourceByName = useMemo(
    () => new Map(sourceColumns.map((c) => [c.name, c])),
    [sourceColumns],
  );
  const orderedNames = useMemo(
    () => buildOrderedSchemaNames(sourceColumns, targetColumns),
    [sourceColumns, targetColumns],
  );

  if (orderedNames.length === 0) {
    return null;
  }

  return (
    <ul className="db-toolbox-column-list db-toolbox-column-list--target-diff">
      {orderedNames.map((name) => {
        const diff = diffByName.get(name);
        const targetCol = targetByName.get(name);
        const sourceCol = sourceByName.get(name);
        const displayCol = targetCol ?? sourceCol;
        if (!displayCol) {
          return null;
        }

        const typeLabel = diff
          ? diff.kind === "added"
            ? diff.sourceType
            : diff.kind === "removed"
              ? diff.targetType
              : diff.targetType && diff.sourceType
                ? `${diff.targetType} → ${diff.sourceType}`
                : displayCol.type
          : displayCol.type;

        return (
          <li
            key={name}
            className={`db-toolbox-column-row${diff ? ` db-toolbox-column-row--${diff.kind}` : ""}`}
          >
            {diff ? <SchemaDiffKindTag kind={diff.kind} /> : null}
            <span className="db-toolbox-column-row__name">{name}</span>
            {typeLabel ? <span className="db-toolbox-column-row__type">{typeLabel}</span> : null}
            {(displayCol.isPk || displayCol.isFk) && (
              <span className="db-toolbox-column-row__flags">
                {displayCol.isPk ? "PK" : null}
                {displayCol.isPk && displayCol.isFk ? " · " : null}
                {displayCol.isFk ? "FK" : null}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function SchemaTargetIndexList({
  sourceIndexes,
  targetIndexes,
  indexDiffs,
}: {
  sourceIndexes: DbIndexMeta[];
  targetIndexes: DbIndexMeta[];
  indexDiffs: SchemaIndexDiff[];
}) {
  const { t } = useI18n();
  const diffByName = useMemo(
    () => new Map(indexDiffs.map((d) => [d.name, d])),
    [indexDiffs],
  );
  const targetByName = useMemo(
    () => new Map(targetIndexes.map((i) => [i.name, i])),
    [targetIndexes],
  );
  const sourceByName = useMemo(
    () => new Map(sourceIndexes.map((i) => [i.name, i])),
    [sourceIndexes],
  );
  const orderedNames = useMemo(
    () => buildOrderedSchemaNames(sourceIndexes, targetIndexes),
    [sourceIndexes, targetIndexes],
  );

  if (orderedNames.length === 0) {
    return null;
  }

  return (
    <>
      <div className="db-toolbox-schema-section-label">{t("database.toolbox.side.schemaDiffIndexes")}</div>
      <ul className="db-toolbox-column-list db-toolbox-column-list--indexes db-toolbox-column-list--target-diff">
        {orderedNames.map((name) => {
          const diff = diffByName.get(name);
          const targetIdx = targetByName.get(name);
          const sourceIdx = sourceByName.get(name);
          const displayIdx = targetIdx ?? sourceIdx;
          if (!displayIdx) {
            return null;
          }

          const detailLabel = diff
            ? diff.kind === "added"
              ? diff.sourceDetail
              : diff.kind === "removed"
                ? diff.targetDetail
                : diff.targetDetail && diff.sourceDetail
                  ? `${diff.targetDetail} → ${diff.sourceDetail}`
                  : undefined
            : undefined;

          const typeLabel = displayIdx.unique ? "UNIQUE" : "INDEX";
          const flagsLabel = detailLabel ?? displayIdx.columns.join(", ");

          return (
            <li
              key={name}
              className={`db-toolbox-column-row${diff ? ` db-toolbox-column-row--${diff.kind}` : ""}`}
            >
              {diff ? <SchemaDiffKindTag kind={diff.kind} /> : null}
              <span className="db-toolbox-column-row__name">{name}</span>
              <span className="db-toolbox-column-row__type">{typeLabel}</span>
              {flagsLabel ? (
                <span className="db-toolbox-column-row__flags">{flagsLabel}</span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function SchemaTargetFieldsSections({
  sourceColumns,
  sourceIndexes,
  targetColumns,
  targetIndexes,
  columnDiffs,
  indexDiffs,
}: {
  sourceColumns: DbColumnMeta[];
  sourceIndexes: DbIndexMeta[];
  targetColumns: DbColumnMeta[];
  targetIndexes: DbIndexMeta[];
  columnDiffs: SchemaColumnDiff[];
  indexDiffs: SchemaIndexDiff[];
}) {
  const { t } = useI18n();
  const hasColumns =
    sourceColumns.length > 0 || targetColumns.length > 0 || columnDiffs.length > 0;

  return (
    <>
      {hasColumns && (
        <>
          <div className="db-toolbox-schema-section-label">{t("database.toolbox.side.schemaDiffColumns")}</div>
          <SchemaTargetColumnList
            sourceColumns={sourceColumns}
            targetColumns={targetColumns}
            columnDiffs={columnDiffs}
          />
        </>
      )}
      <SchemaTargetIndexList
        sourceIndexes={sourceIndexes}
        targetIndexes={targetIndexes}
        indexDiffs={indexDiffs}
      />
    </>
  );
}

function SchemaTableFieldsSections({
  columns,
  indexes,
}: {
  columns: DbColumnMeta[];
  indexes: DbIndexMeta[];
}) {
  const { t } = useI18n();

  return (
    <>
      {columns.length > 0 && (
        <>
          <div className="db-toolbox-schema-section-label">{t("database.toolbox.side.schemaDiffColumns")}</div>
          <SchemaColumnList columns={columns} />
        </>
      )}
      <SchemaIndexList indexes={indexes} />
    </>
  );
}

function SchemaColumnList({ columns }: { columns: DbColumnMeta[] }) {
  if (columns.length === 0) return null;

  return (
    <ul className="db-toolbox-column-list">
      {columns.map((col) => (
        <li key={col.name} className="db-toolbox-column-row">
          <span className="db-toolbox-column-row__name">{col.name}</span>
          <span className="db-toolbox-column-row__type">{col.type}</span>
          {(col.isPk || col.isFk) && (
            <span className="db-toolbox-column-row__flags">
              {col.isPk ? "PK" : null}
              {col.isPk && col.isFk ? " · " : null}
              {col.isFk ? "FK" : null}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function SchemaIndexList({ indexes }: { indexes: DbIndexMeta[] }) {
  const { t } = useI18n();
  if (indexes.length === 0) return null;

  return (
    <>
      <div className="db-toolbox-schema-section-label">{t("database.toolbox.side.schemaDiffIndexes")}</div>
      <ul className="db-toolbox-column-list db-toolbox-column-list--indexes">
        {indexes.map((idx) => (
          <li key={idx.name} className="db-toolbox-column-row">
            <span className="db-toolbox-column-row__name">{idx.name}</span>
            <span className="db-toolbox-column-row__type">
              {idx.unique ? "UNIQUE" : "INDEX"}
            </span>
            <span className="db-toolbox-column-row__flags">{idx.columns.join(", ")}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function SchemaTableStatusTag({ status }: { status?: SchemaTableDiff["status"] }) {
  const { t } = useI18n();
  if (!status || status === "checking") {
    return null;
  }
  if (status === "match") {
    return (
      <span className="db-toolbox-sync-tag db-toolbox-sync-tag--match">
        {t("database.toolbox.side.schemaDiffMatch")}
      </span>
    );
  }
  if (status === "new") {
    return (
      <span className="db-toolbox-sync-tag db-toolbox-sync-tag--new">
        {t("database.toolbox.side.tagNew")}
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="db-toolbox-sync-tag db-toolbox-sync-tag--error">
        {t("database.toolbox.side.schemaDiffLoadFailed")}
      </span>
    );
  }
  if (status === "diff") {
    return (
      <span className="db-toolbox-sync-tag db-toolbox-sync-tag--diff">
        {t("database.toolbox.side.schemaDiffChanged")}
      </span>
    );
  }
  return null;
}

function SchemaTargetRowStatusTag({
  sourcePresent,
  sourceSelected,
  targetOnly,
  diffStatus,
}: {
  sourcePresent: boolean;
  sourceSelected: boolean;
  targetOnly: boolean;
  diffStatus?: SchemaTableDiff["status"];
}) {
  const { t } = useI18n();
  if (targetOnly) {
    return (
      <span className="db-toolbox-sync-tag db-toolbox-sync-tag--target-only">
        {t("database.toolbox.side.schemaDiffTargetOnly")}
      </span>
    );
  }
  if (sourcePresent && !sourceSelected) {
    return (
      <span className="db-toolbox-sync-tag db-toolbox-sync-tag--ignore">
        {t("database.toolbox.side.tagIgnore")}
      </span>
    );
  }
  return <SchemaTableStatusTag status={diffStatus} />;
}

function SchemaPlaceholderRow({ tableName }: { tableName: string }) {
  return (
    <li
      className="db-toolbox-schema-table db-toolbox-schema-table--placeholder"
      data-schema-sync-row={tableName}
      aria-hidden
    >
      <div className="db-toolbox-schema-table__head db-toolbox-schema-table__head--placeholder">
        <span className="db-toolbox-table-row__name db-toolbox-table-row__name--placeholder">—</span>
      </div>
    </li>
  );
}

function SchemaTargetSourceOnlyRow({
  tableName,
  diff,
  sourceColumns,
  sourceIndexes,
  sourceSelected,
  expanded,
  onToggle,
}: {
  tableName: string;
  diff?: SchemaTableDiff;
  sourceColumns: DbColumnMeta[];
  sourceIndexes: DbIndexMeta[];
  sourceSelected: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const colCount = sourceColumns.length;
  const idxCount = sourceIndexes.length;

  return (
    <li className="db-toolbox-schema-table" data-schema-sync-row={tableName}>
      <div
        className="db-toolbox-schema-table__head db-toolbox-schema-table__head--target"
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <span className={`tree-arrow${expanded ? " tree-arrow--open" : ""}`}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="10" height="10">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </span>
        <span className="db-toolbox-table-row__name">{tableName}</span>
        <SchemaTargetRowStatusTag
          sourcePresent
          sourceSelected={sourceSelected}
          targetOnly={false}
          diffStatus={diff?.status ?? "new"}
        />
        <span className="db-toolbox-table-row__meta">
          {t("database.toolbox.side.schemaMetaCount", { columns: colCount, indexes: idxCount })}
        </span>
      </div>
      {expanded && diff ? (
        <SchemaTargetFieldsSections
          sourceColumns={sourceColumns}
          sourceIndexes={sourceIndexes}
          targetColumns={[]}
          targetIndexes={[]}
          columnDiffs={diff.columns}
          indexDiffs={diff.indexes}
        />
      ) : null}
    </li>
  );
}

function SchemaTargetSyncTableRow({
  tableName,
  diff,
  sourceColumns,
  sourceIndexes,
  targetColumns,
  targetIndexes,
  sourcePresent,
  sourceSelected,
  expanded,
  onToggle,
}: {
  tableName: string;
  diff?: SchemaTableDiff;
  sourceColumns: DbColumnMeta[];
  sourceIndexes: DbIndexMeta[];
  targetColumns: DbColumnMeta[];
  targetIndexes: DbIndexMeta[];
  sourcePresent: boolean;
  sourceSelected: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const status = diff?.status ?? "checking";
  const colCount = sourcePresent ? sourceColumns.length : targetColumns.length;
  const idxCount = sourcePresent ? sourceIndexes.length : targetIndexes.length;
  const targetOnly = !sourcePresent && targetColumns.length > 0;

  const metaLabel =
    status === "checking"
      ? t("database.toolbox.side.tagChecking")
      : t("database.toolbox.side.schemaMetaCount", { columns: colCount, indexes: idxCount });

  return (
    <li className="db-toolbox-schema-table" data-schema-sync-row={tableName}>
      <div
        className="db-toolbox-schema-table__head db-toolbox-schema-table__head--target"
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <span className={`tree-arrow${expanded ? " tree-arrow--open" : ""}`}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="10" height="10">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </span>
        <span className="db-toolbox-table-row__name">{tableName}</span>
        <SchemaTargetRowStatusTag
          sourcePresent={sourcePresent}
          sourceSelected={sourceSelected}
          targetOnly={targetOnly}
          diffStatus={status}
        />
        <span className="db-toolbox-table-row__meta">{metaLabel}</span>
      </div>
      {expanded && status === "error" && diff?.error && (
        <div className="db-toolbox-schema-target-table__error">{diff.error}</div>
      )}
      {expanded && (
        <>
          {sourcePresent && (status === "new" || status === "diff") && diff ? (
            <SchemaTargetFieldsSections
              sourceColumns={sourceColumns}
              sourceIndexes={sourceIndexes}
              targetColumns={targetColumns}
              targetIndexes={targetIndexes}
              columnDiffs={diff.columns}
              indexDiffs={diff.indexes}
            />
          ) : (
            <SchemaTableFieldsSections
              columns={targetColumns.length > 0 ? targetColumns : sourceColumns}
              indexes={targetIndexes.length > 0 ? targetIndexes : sourceIndexes}
            />
          )}
        </>
      )}
    </li>
  );
}

export function SyncSidePanel({
  sideLabel,
  tableListMode = "source",
  connections,
  connectionId,
  database,
  onConnectionChange,
  onDatabaseChange,
  databases,
  databasesLoading,
  snapshot,
  loadingProgress,
  tab,
  expandedTables,
  onToggleTable,
  selectedTables,
  onToggleSelect,
  onSelectAllTables,
  countingTables,
  sourceSelectedTableNames = [],
  targetConfigured = false,
  targetTablesLoading = false,
  tableTargetStatus = {},
  tableSyncStrategies = {},
  onSyncStrategyChange,
  schemaTableDiffs = {},
  tableAnalysis = {},
  conflictDetailTable = null,
  onViewConflictDetail,
  showMatchingTables: _showMatchingTables,
  onShowMatchingTablesChange: _onShowMatchingTablesChange,
  schemaStatusFilters = [],
  onSchemaStatusFiltersChange,
  sourceTableColumns = {},
  sourceTableIndexes = {},
  alignedTableNames,
  targetSnapshot,
  schemaTableSearch,
  onSchemaTableSearchChange,
  sourceTableNames,
  schemaCaseSensitive = true,
  scrollListRef,
  onAnalyze,
  analyzeBusy,
  hasAnalysisResult = false,
}: SyncSidePanelProps) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const selectAllRef = useRef<HTMLInputElement>(null);
  const isTargetSync = tableListMode === "targetSync";
  const isSchemaAligned = tab === "schemaSync" && alignedTableNames !== undefined;
  const schemaCompareCaseSensitive = isSchemaCaseSensitive(schemaCaseSensitive);

  const resolveSourceTable = useCallback(
    (name: string): SyncTableInfo | undefined => {
      if (isTargetSync) {
        if (!sourceTableNames?.size) {
          return undefined;
        }
        if (schemaCompareCaseSensitive) {
          if (!sourceTableNames.has(name)) {
            return undefined;
          }
          return {
            name,
            columns: sourceTableColumns[name] ?? [],
            indexes: sourceTableIndexes[name] ?? [],
            rowCount: null,
          };
        }
        for (const tableName of sourceTableNames) {
          if (tableName.toLowerCase() === name.toLowerCase()) {
            return {
              name: tableName,
              columns: sourceTableColumns[tableName] ?? sourceTableColumns[name] ?? [],
              indexes: sourceTableIndexes[tableName] ?? sourceTableIndexes[name] ?? [],
              rowCount: null,
            };
          }
        }
        return undefined;
      }
      return findTableByName(snapshot.tables, name, schemaCompareCaseSensitive);
    },
    [
      isTargetSync,
      snapshot.tables,
      sourceTableNames,
      sourceTableColumns,
      sourceTableIndexes,
      schemaCompareCaseSensitive,
    ],
  );

  const isSourceTablePresent = useCallback(
    (name: string): boolean => {
      if (!sourceTableNames?.size) {
        return false;
      }
      return tableNameExistsInSet(sourceTableNames, name, schemaCompareCaseSensitive);
    },
    [sourceTableNames, schemaCompareCaseSensitive],
  );

  const resolveTargetTable = useCallback(
    (name: string): SyncTableInfo | undefined =>
      findTableByName(targetSnapshot?.tables ?? [], name, schemaCompareCaseSensitive),
    [targetSnapshot?.tables, schemaCompareCaseSensitive],
  );

  const resolveSourceColumns = useCallback(
    (name: string): DbColumnMeta[] =>
      resolveSourceTable(name)?.columns ?? sourceTableColumns[name] ?? [],
    [resolveSourceTable, sourceTableColumns],
  );

  const resolveSourceIndexes = useCallback(
    (name: string): DbIndexMeta[] =>
      resolveSourceTable(name)?.indexes ?? sourceTableIndexes[name] ?? [],
    [resolveSourceTable, sourceTableIndexes],
  );

  useEffect(() => {
    setSearch("");
  }, [connectionId, database, tab]);

  const filteredTables = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return snapshot.tables;
    return snapshot.tables.filter((tbl) => tbl.name.toLowerCase().includes(q));
  }, [snapshot.tables, search]);

  const visibleNames = useMemo(() => filteredTables.map((tbl) => tbl.name), [filteredTables]);

  const targetSyncRows = useMemo(() => {
    const names = [...sourceSelectedTableNames].sort((a, b) => a.localeCompare(b));
    return names.map((name) => ({
      name,
      status: tableTargetStatus[name] ?? (targetTablesLoading ? "checking" : undefined),
      strategy: tableSyncStrategies[name] ?? "rewrite",
      analysis: tableAnalysis[name],
    }));
  }, [
    sourceSelectedTableNames,
    tableTargetStatus,
    tableSyncStrategies,
    targetTablesLoading,
    tableAnalysis,
  ]);

  const schemaTargetTableNames = useMemo(() => {
    if (isSchemaAligned) {
      return alignedTableNames ?? [];
    }
    const names = [...sourceSelectedTableNames].sort((a, b) => a.localeCompare(b));
    if (tab === "schemaSync" && !isSchemaTargetStatusFilterShowAll(schemaStatusFilters) && isTargetSync) {
      return filterAlignedTableNamesByStatus(
        names,
        schemaStatusFilters,
        schemaTableDiffs,
        () => true,
        (name) => Boolean(resolveTargetTable(name)),
      );
    }
    return names;
  }, [
    isSchemaAligned,
    alignedTableNames,
    sourceSelectedTableNames,
    tab,
    isTargetSync,
    schemaStatusFilters,
    schemaTableDiffs,
    resolveTargetTable,
  ]);

  const selectAllVisibleNames = useMemo(() => {
    if (isSchemaAligned) {
      return schemaTargetTableNames.filter((name) => resolveSourceTable(name) !== undefined);
    }
    return visibleNames;
  }, [isSchemaAligned, schemaTargetTableNames, resolveSourceTable, visibleNames]);

  const allVisibleSelected =
    selectAllVisibleNames.length > 0 &&
    selectAllVisibleNames.every((name) => selectedTables.has(name));
  const someVisibleSelected = selectAllVisibleNames.some((name) => selectedTables.has(name));

  useEffect(() => {
    const el = selectAllRef.current;
    if (!el) return;
    el.indeterminate = someVisibleSelected && !allVisibleSelected;
  }, [someVisibleSelected, allVisibleSelected]);

  const handleSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (selectAllVisibleNames.length > 0) {
        onSelectAllTables(selectAllVisibleNames, true);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (isSchemaAligned) {
        onSchemaTableSearchChange?.("");
      } else {
        setSearch("");
      }
    }
  };

  const sourceSearchValue = isSchemaAligned ? (schemaTableSearch ?? "") : search;
  const handleSourceSearchChange = isSchemaAligned
    ? (value: string) => onSchemaTableSearchChange?.(value)
    : setSearch;

  const showSchemaStatusFilter =
    isTargetSync &&
    tab === "schemaSync" &&
    isSchemaAligned &&
    schemaStatusFilters !== undefined &&
    onSchemaStatusFiltersChange;

  const showTargetAnalyze = isTargetSync && onAnalyze !== undefined;

  return (
    <section className={`db-toolbox-side${isTargetSync ? " db-toolbox-side--target-sync" : ""}`}>
      <header className="db-toolbox-side__header">
        <h4 className="db-toolbox-side__title">{sideLabel}</h4>
        <ConnectionDatabaseFilters
          connections={connections}
          connectionId={connectionId}
          database={database}
          onConnectionChange={onConnectionChange}
          onDatabaseChange={onDatabaseChange}
          databases={databases}
          databasesLoading={databasesLoading}
          showSelectAll={!isTargetSync}
          selectAllRef={selectAllRef}
          allVisibleSelected={allVisibleSelected}
          visibleNames={selectAllVisibleNames}
          onSelectAllTables={onSelectAllTables}
          search={!isTargetSync ? sourceSearchValue : undefined}
          onSearchChange={!isTargetSync ? handleSourceSearchChange : undefined}
          onSearchKeyDown={!isTargetSync && !isSchemaAligned ? handleSearchKeyDown : undefined}
          searchPlaceholder={t("database.toolbox.side.searchTables")}
          toolbarLayout={
            showSchemaStatusFilter || showTargetAnalyze
              ? "targetRow"
              : isTargetSync
                ? "default"
                : "sourceRow"
          }
          schemaStatusFilters={showSchemaStatusFilter ? schemaStatusFilters : undefined}
          onSchemaStatusFiltersChange={
            showSchemaStatusFilter ? onSchemaStatusFiltersChange : undefined
          }
          onAnalyze={showTargetAnalyze ? onAnalyze : undefined}
          analyzeBusy={showTargetAnalyze ? analyzeBusy : undefined}
          hasAnalysisResult={showTargetAnalyze ? hasAnalysisResult : undefined}
        />
      </header>

      <div className="db-toolbox-side__list" ref={scrollListRef}>
        {isTargetSync ? (
          !targetConfigured ? (
            <div className="db-toolbox-side__empty">{t("database.toolbox.side.selectTargetFirst")}</div>
          ) : tab === "schemaSync" && isSchemaAligned ? (
            targetSnapshot?.loading || targetTablesLoading ? (
              <DataLoading total={1} current={0} className="db-toolbox-side__loading" />
            ) : schemaTargetTableNames.length === 0 ? (
              <div className="db-toolbox-side__empty">
                {!isSchemaTargetStatusFilterShowAll(schemaStatusFilters)
                  ? t("database.toolbox.side.schemaStatusFilterNoMatch")
                  : t("database.toolbox.side.emptyMatchingHidden")}
              </div>
            ) : (
              <ul className="db-toolbox-table-list db-toolbox-table-list--target db-toolbox-table-list--schema-target">
                {schemaTargetTableNames.map((name) => {
                  const targetTable = resolveTargetTable(name);
                  const sourcePresent = isSourceTablePresent(name);
                  if (!targetTable) {
                    if (sourcePresent) {
                      return (
                        <SchemaTargetSourceOnlyRow
                          key={name}
                          tableName={name}
                          diff={schemaTableDiffs[name]}
                          sourceColumns={resolveSourceColumns(name)}
                          sourceIndexes={resolveSourceIndexes(name)}
                          sourceSelected={selectedTables.has(name)}
                          expanded={expandedTables.has(name)}
                          onToggle={() => onToggleTable(name)}
                        />
                      );
                    }
                    return <SchemaPlaceholderRow key={name} tableName={name} />;
                  }
                  return (
                    <SchemaTargetSyncTableRow
                      key={name}
                      tableName={name}
                      diff={schemaTableDiffs[name]}
                      sourceColumns={resolveSourceColumns(name)}
                      sourceIndexes={resolveSourceIndexes(name)}
                      targetColumns={targetTable.columns}
                      targetIndexes={targetTable.indexes}
                      sourcePresent={sourcePresent}
                      sourceSelected={sourcePresent ? selectedTables.has(name) : false}
                      expanded={expandedTables.has(name)}
                      onToggle={() => onToggleTable(name)}
                    />
                  );
                })}
              </ul>
            )
          ) : sourceSelectedTableNames.length === 0 ? (
            <div className="db-toolbox-side__empty">{t("database.toolbox.side.emptyTargetSync")}</div>
          ) : tab === "schemaSync" ? (
            schemaTargetTableNames.length === 0 ? (
              <div className="db-toolbox-side__empty">{t("database.toolbox.side.emptyMatchingHidden")}</div>
            ) : (
              <ul className="db-toolbox-table-list db-toolbox-table-list--target db-toolbox-table-list--schema-target">
                {schemaTargetTableNames.map((name) => (
                  <SchemaTargetSyncTableRow
                    key={name}
                    tableName={name}
                    diff={schemaTableDiffs[name]}
                    sourceColumns={resolveSourceColumns(name)}
                    sourceIndexes={resolveSourceIndexes(name)}
                    targetColumns={[]}
                    targetIndexes={[]}
                    sourcePresent
                    sourceSelected={selectedTables.has(name)}
                    expanded={expandedTables.has(name)}
                    onToggle={() => onToggleTable(name)}
                  />
                ))}
              </ul>
            )
          ) : targetSyncRows.length === 0 ? (
            <div className="db-toolbox-side__empty">{t("database.toolbox.side.emptyTargetSync")}</div>
          ) : (
            <ul className="db-toolbox-table-list db-toolbox-table-list--target">
              {targetSyncRows.map((row) => (
                <TargetSyncTableRow
                  key={row.name}
                  tableName={row.name}
                  targetStatus={row.status}
                  syncStrategy={row.strategy}
                  onSyncStrategyChange={onSyncStrategyChange}
                  analysis={row.analysis}
                  detailOpen={conflictDetailTable === row.name}
                  onViewConflictDetail={onViewConflictDetail}
                />
              ))}
            </ul>
          )
        ) : snapshot.loading ? (
          <DataLoading
            total={loadingProgress?.total ?? 1}
            current={loadingProgress?.current ?? 0}
            message={loadingProgress?.message}
            className="db-toolbox-side__loading"
          />
        ) : snapshot.error ? (
          <div className="db-toolbox-side__empty db-toolbox-side__empty--error">{snapshot.error}</div>
        ) : snapshot.tables.length === 0 ? (
          <div className="db-toolbox-side__empty">{t("database.toolbox.side.emptyTables")}</div>
        ) : filteredTables.length === 0 && !isSchemaAligned ? (
          <div className="db-toolbox-side__empty">{t("database.toolbox.side.noSearchMatch")}</div>
        ) : tab === "schemaSync" && isSchemaAligned ? (
          snapshot.loading ? (
            <DataLoading
              total={loadingProgress?.total ?? 1}
              current={loadingProgress?.current ?? 0}
              message={loadingProgress?.message}
              className="db-toolbox-side__loading"
            />
          ) : schemaTargetTableNames.length === 0 ? (
            <div className="db-toolbox-side__empty">
              {!isSchemaTargetStatusFilterShowAll(schemaStatusFilters)
                ? t("database.toolbox.side.schemaStatusFilterNoMatch")
                : t("database.toolbox.side.noSearchMatch")}
            </div>
          ) : (
            <ul className="db-toolbox-table-list db-toolbox-table-list--schema">
              {schemaTargetTableNames.map((name) => {
                const table = resolveSourceTable(name);
                if (!table) {
                  return <SchemaPlaceholderRow key={name} tableName={name} />;
                }
                return (
                  <SchemaSyncTableRow
                    key={name}
                    table={table}
                    expanded={expandedTables.has(name)}
                    selected={selectedTables.has(name)}
                    onToggle={() => onToggleTable(name)}
                    onToggleSelect={onToggleSelect}
                  />
                );
              })}
            </ul>
          )
        ) : tab === "dataSync" ? (
          <ul className="db-toolbox-table-list">
            {filteredTables.map((table) => (
              <DataSyncTableRow
                key={table.name}
                table={table}
                selected={selectedTables.has(table.name)}
                counting={countingTables?.has(table.name) ?? false}
                onToggleSelect={onToggleSelect}
              />
            ))}
          </ul>
        ) : (
          <ul className="db-toolbox-table-list db-toolbox-table-list--schema">
            {filteredTables.map((table) => (
              <SchemaSyncTableRow
                key={table.name}
                table={table}
                expanded={expandedTables.has(table.name)}
                selected={selectedTables.has(table.name)}
                onToggle={() => onToggleTable(table.name)}
                onToggleSelect={onToggleSelect}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function DataSyncTableRow({
  table,
  selected,
  counting,
  onToggleSelect,
}: {
  table: SyncTableInfo;
  selected: boolean;
  counting: boolean;
  onToggleSelect: (tableName: string) => void;
}) {
  const { t } = useI18n();
  const failed = table.rowCount !== null && table.rowCount < 0;

  const metaLabel = !selected
    ? "—"
    : counting || table.rowCount === null
      ? t("database.toolbox.side.counting")
      : failed
        ? t("database.toolbox.side.countFailed")
        : t("database.toolbox.side.rowCount", { count: table.rowCount });

  return (
    <li className="db-toolbox-table-row">
      <TableSelectCheckbox
        tableName={table.name}
        checked={selected}
        onToggle={onToggleSelect}
      />
      <span className="db-toolbox-table-row__name">{table.name}</span>
      <span className={`db-toolbox-table-row__meta${failed && selected ? " text-danger" : ""}`}>
        {metaLabel}
      </span>
    </li>
  );
}

function SchemaSyncTableRow({
  table,
  expanded,
  selected,
  onToggle,
  onToggleSelect,
}: {
  table: SyncTableInfo;
  expanded: boolean;
  selected: boolean;
  onToggle: () => void;
  onToggleSelect: (tableName: string) => void;
}) {
  const { t } = useI18n();
  const colCount = table.columns.length;
  const idxCount = table.indexes.length;

  return (
    <li className="db-toolbox-schema-table" data-schema-sync-row={table.name}>
      <div
        className="db-toolbox-schema-table__head"
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <TableSelectCheckbox
          tableName={table.name}
          checked={selected}
          onToggle={onToggleSelect}
        />
        <span className={`tree-arrow${expanded ? " tree-arrow--open" : ""}`}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="10" height="10">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </span>
        <span className="db-toolbox-table-row__name">{table.name}</span>
        <span className="db-toolbox-table-row__meta">
          {t("database.toolbox.side.schemaMetaCount", { columns: colCount, indexes: idxCount })}
        </span>
      </div>
      {expanded && (
        <SchemaTableFieldsSections columns={table.columns} indexes={table.indexes} />
      )}
    </li>
  );
}
