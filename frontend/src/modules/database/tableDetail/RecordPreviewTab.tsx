import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../../../i18n";
import type { DbColumnMeta } from "../api";
import {
  detectCellEditorKind,
  formatCellValue,
  parseCellValue,
  type CellEditorKind,
} from "../cell_editor/types";
import { BooleanEditor } from "../cell_editor/BooleanEditor";

export interface RecordPreviewTabProps {
  columns: string[];
  columnMeta?: DbColumnMeta[];
  row: Record<string, unknown> | null;
  cellOverrides?: Record<string, unknown>;
  onApply: (column: string, payload: { rawText: string; parsed: unknown }) => void;
  onSetNull?: (column: string) => void;
}

function FieldIcon({ isPk }: { isPk?: boolean }) {
  if (isPk) {
    return (
      <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
        <circle cx="6" cy="8" r="2.5" />
        <path d="M8.5 8h5M11.5 6.5v3" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M3 4.5h10M3 8h10M3 11.5h6" strokeLinecap="round" />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M3 3l6 6M9 3 3 9" strokeLinecap="round" />
    </svg>
  );
}

function isMultilineKind(kind: CellEditorKind, text: string): boolean {
  return kind === "json" || (kind === "text" && text.length > 64);
}

function RecordFieldEditor({
  column,
  meta,
  value,
  onApply,
}: {
  column: string;
  meta?: DbColumnMeta;
  value: unknown;
  onApply: (payload: { rawText: string; parsed: unknown }) => void;
}) {
  const kind = detectCellEditorKind(meta?.type ?? "text");
  const baseline = formatCellValue(value);
  const [text, setText] = useState(baseline);
  const multiline = isMultilineKind(kind, text);

  useEffect(() => {
    setText(baseline);
  }, [baseline, column]);

  const commit = useCallback(
    (next: string) => {
      const parsed = parseCellValue(kind, next);
      onApply({ rawText: next, parsed });
    },
    [kind, onApply],
  );

  if (kind === "boolean") {
    return (
      <BooleanEditor
        autoFocus={false}
        value={text || "false"}
        onChange={(v) => {
          setText(v);
          commit(v);
        }}
      />
    );
  }

  if (!multiline) {
    return (
      <input
        className="db-record-field-input db-record-field-input--single"
        value={text}
        placeholder={value === null || value === undefined ? "NULL" : undefined}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text !== baseline) commit(text);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    );
  }

  return (
    <textarea
      className="db-record-field-input db-record-field-input--multi"
      rows={kind === "json" || text.length > 120 ? 3 : 2}
      value={text}
      placeholder={value === null || value === undefined ? "NULL" : undefined}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text !== baseline) commit(text);
      }}
    />
  );
}

function shortenType(type: string): string {
  const trimmed = type.trim();
  if (trimmed.length <= 18) return trimmed;
  return `${trimmed.slice(0, 16)}…`;
}

export function RecordPreviewTab({
  columns,
  columnMeta,
  row,
  cellOverrides,
  onApply,
  onSetNull,
}: RecordPreviewTabProps) {
  const { t } = useI18n();
  const metaByName = useMemo(() => {
    const map = new Map<string, DbColumnMeta>();
    for (const col of columnMeta ?? []) {
      map.set(col.name, col);
    }
    return map;
  }, [columnMeta]);

  if (!row) {
    return (
      <div className="db-table-detail-empty">
        {t("database.tableDetail.selectRowHint")}
      </div>
    );
  }

  return (
    <div className="db-record-preview">
      {columns.map((column) => {
        const meta = metaByName.get(column);
        const value =
          cellOverrides && cellOverrides[column] !== undefined
            ? cellOverrides[column]
            : row[column];
        const typeLabel = meta?.type?.trim() || null;
        const comment = meta?.comment?.trim() || "";
        const isNull = value === null || value === undefined;
        const canClear = Boolean(onSetNull) && !isNull;

        return (
          <div
            key={column}
            className={`db-record-field${meta?.isPk ? " db-record-field--pk" : ""}${isNull ? " db-record-field--null" : ""}`}
          >
            <div className="db-record-field-head">
              <span className={`db-record-field-icon${meta?.isPk ? " is-pk" : ""}`}>
                <FieldIcon isPk={meta?.isPk} />
              </span>
              <div className="db-record-field-title-row">
                <span className="db-record-field-name" title={comment ? `${column} · ${comment}` : column}>
                  {column}
                </span>
                {typeLabel ? (
                  <span className="db-record-field-type" title={typeLabel}>
                    {shortenType(typeLabel)}
                  </span>
                ) : null}
                {meta?.isPk ? <span className="db-record-field-badge">PK</span> : null}
                {comment ? (
                  <span className="db-record-field-comment" title={comment}>
                    {comment}
                  </span>
                ) : null}
              </div>
            </div>
            <div className="db-record-field-value-row">
              <div
                className={`db-record-field-value${isNull ? " is-null" : ""}${canClear ? " has-clear" : ""}`}
              >
                <RecordFieldEditor
                  column={column}
                  meta={meta}
                  value={value}
                  onApply={(payload) => onApply(column, payload)}
                />
                {canClear ? (
                  <button
                    type="button"
                    className="db-record-field-clear-btn"
                    onClick={() => onSetNull?.(column)}
                    title={t("database.cellEditor.setNull")}
                    aria-label={t("database.cellEditor.setNull")}
                  >
                    <ClearIcon />
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
