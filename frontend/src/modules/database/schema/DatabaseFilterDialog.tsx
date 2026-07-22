import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../../i18n";
import { FormDialog } from "../../../components/ui/form/FormDialog";
import { TextInput } from "../../../components/ui/form/TextInput";
import { rankByFuzzy } from "../../../lib/fuzzyMatch";
import type { SchemaFilterState } from "./schemaFilterState";

export type { SchemaFilterState } from "./schemaFilterState";
export {
  applyTablePinOrder,
  createDefaultFilter,
  getVisibleItems,
  getVisibleNames,
  isTablePinned,
  makeTableFilterKey,
  mergeFilter,
  toggleTablePin,
} from "./schemaFilterState";

interface SchemaFilterDialogProps {
  open: boolean;
  title: string;
  items: string[];
  initial: SchemaFilterState;
  onClose: () => void;
  onApply: (state: SchemaFilterState) => void;
}

export function SchemaFilterDialog({
  open,
  title,
  items,
  initial,
  onClose,
  onApply,
}: SchemaFilterDialogProps) {
  const { t } = useI18n();
  const [ordered, setOrdered] = useState<string[]>(initial.orderedNames);
  const [visible, setVisible] = useState<Set<string>>(new Set(initial.visibleNames));
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const selectAllRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setOrdered(initial.orderedNames.length > 0 ? initial.orderedNames : items);
    setVisible(new Set(initial.visibleNames.size > 0 ? initial.visibleNames : items));
    setDragIndex(null);
    setQuery("");
  }, [open, items, initial]);

  const filteredOrdered = useMemo(
    () => (query.trim() ? rankByFuzzy(ordered, query, (name) => name) : ordered),
    [ordered, query],
  );

  const allSelected = ordered.length > 0 && visible.size === ordered.length;
  const someSelected = visible.size > 0;

  useEffect(() => {
    const el = selectAllRef.current;
    if (!el) {
      return;
    }
    el.indeterminate = someSelected && !allSelected;
  }, [someSelected, allSelected]);

  const toggleOne = (name: string) => {
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  const toggleAll = () => {
    setVisible(allSelected ? new Set() : new Set(ordered));
  };

  const moveItem = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= ordered.length || to >= ordered.length) {
      return;
    }
    setOrdered((prev) => {
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  };

  const handleApply = () => {
    onApply({ orderedNames: ordered, visibleNames: visible });
    onClose();
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={title}
      className="db-filter-dialog"
      onCancel={onClose}
      primaryAction={{
        label: t("database.filter.apply"),
        onClick: handleApply,
      }}
    >
          <div className="db-filter-toolbar">
            <label className="db-filter-toggle-all">
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
              />
              <span>{t("database.filter.selectAll")}</span>
            </label>
            <span className="db-filter-count">
              {t("database.filter.selectedCount", { count: visible.size, total: ordered.length })}
            </span>
          </div>

          <div className="db-filter-search">
            <svg viewBox="0 0 16 16" className="db-filter-search-icon" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
              <circle cx="7" cy="7" r="4.5" />
              <path d="M10.5 10.5L14 14" strokeLinecap="round" />
            </svg>
            <TextInput
              copyable={false}
              className="db-filter-search-input"
              placeholder={t("database.filter.searchPlaceholder")}
              value={query}
              onChange={setQuery}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleApply();
                }
              }}
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
          </div>

          <div className="db-filter-list">
            {filteredOrdered.length === 0 ? (
              <div className="db-filter-empty">{t("database.filter.noResults")}</div>
            ) : (
              filteredOrdered.map((name) => {
                const index = ordered.indexOf(name);
                return (
                  <div
                    key={name}
                    className={`db-filter-item${dragIndex === index ? " db-filter-item--dragging" : ""}`}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => {
                      if (dragIndex !== null) {
                        moveItem(dragIndex, index);
                      }
                      setDragIndex(null);
                    }}
                  >
                    <button
                      type="button"
                      className="db-filter-drag"
                      draggable
                      title={t("database.filter.dragHint")}
                      onDragStart={() => setDragIndex(index)}
                      onDragEnd={() => setDragIndex(null)}
                    >
                      <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12">
                        <circle cx="9" cy="6" r="1.2" />
                        <circle cx="15" cy="6" r="1.2" />
                        <circle cx="9" cy="12" r="1.2" />
                        <circle cx="15" cy="12" r="1.2" />
                        <circle cx="9" cy="18" r="1.2" />
                        <circle cx="15" cy="18" r="1.2" />
                      </svg>
                    </button>
                    <label className="db-filter-check">
                      <input type="checkbox" checked={visible.has(name)} onChange={() => toggleOne(name)} />
                      <span>{name}</span>
                    </label>
                  </div>
                );
              })
            )}
          </div>
    </FormDialog>
  );
}
