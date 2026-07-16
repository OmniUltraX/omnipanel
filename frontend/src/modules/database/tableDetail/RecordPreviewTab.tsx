import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../../../i18n";
import type { DbColumnMeta } from "../api";
import {
  detectCellEditorKind,
  formatCellValue,
  parseCellValue,
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
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
        <circle cx="6" cy="8" r="2.5" />
        <path d="M8.5 8h5M11.5 6.5v3" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <rect x="2.5" y="3.5" width="11" height="9" rx="1" />
      <path d="M5 3.5v9M8.5 3.5v9" />
    </svg>
  );
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
  onSetNull?: () => void;
}) {
  const kind = detectCellEditorKind(meta?.type ?? "text");
  const baseline = formatCellValue(value);
  const [text, setText] = useState(baseline);

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

  return (
    <textarea
      className="db-record-field-input"
      rows={kind === "json" || text.length > 80 ? 3 : 1}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text !== baseline) commit(text);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey && kind !== "json" && text.length <= 80) {
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        }
      }}
    />
  );
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
        return (
          <div key={column} className="db-record-field">
            <div className="db-record-field-label">
              <FieldIcon isPk={meta?.isPk} />
              <span title={meta?.type ?? column}>{column}</span>
              {onSetNull && value !== null && value !== undefined ? (
                <button
                  type="button"
                  className="db-record-field-null-btn"
                  onClick={() => onSetNull(column)}
                  title={t("database.cellEditor.setNull")}
                >
                  NULL
                </button>
              ) : null}
            </div>
            <RecordFieldEditor
              column={column}
              meta={meta}
              value={value}
              onApply={(payload) => onApply(column, payload)}
              onSetNull={onSetNull ? () => onSetNull(column) : undefined}
            />
          </div>
        );
      })}
    </div>
  );
}
