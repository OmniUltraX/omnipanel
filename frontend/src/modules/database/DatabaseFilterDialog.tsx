import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { Button } from "../../components/ui/Button";
import { FormDialog } from "../../components/ui/FormDialog";
import { rankByFuzzy } from "../../lib/fuzzyMatch";

export interface SchemaFilterState {
  orderedNames: string[];
  visibleNames: Set<string>;
}

/** @deprecated use SchemaFilterState */
export type DatabaseFilterState = SchemaFilterState;

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
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setOrdered(initial.orderedNames.length > 0 ? initial.orderedNames : items);
    setVisible(new Set(initial.visibleNames.size > 0 ? initial.visibleNames : items));
    setDragIndex(null);
    setQuery("");
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, [open, items, initial]);

  const filteredOrdered = useMemo(
    () => (query.trim() ? rankByFuzzy(ordered, query, (name) => name) : ordered),
    [ordered, query],
  );

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

  const selectAll = () => setVisible(new Set(ordered));
  const deselectAll = () => setVisible(new Set());

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
            <span className="db-filter-count">
              {t("database.filter.selectedCount", { count: visible.size, total: ordered.length })}
            </span>
            <Button variant="ghost" size="sm" type="button" onClick={selectAll}>
              {t("database.filter.selectAll")}
            </Button>
            <Button variant="ghost" size="sm" type="button" onClick={deselectAll}>
              {t("database.filter.deselectAll")}
            </Button>
          </div>

          <div className="db-filter-search">
            <svg viewBox="0 0 16 16" className="db-filter-search-icon" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
              <circle cx="7" cy="7" r="4.5" />
              <path d="M10.5 10.5L14 14" strokeLinecap="round" />
            </svg>
            <input
              ref={searchInputRef}
              type="text"
              className="db-filter-search-input"
              placeholder={t("database.filter.searchPlaceholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleApply();
                }
              }}
              autoComplete="off"
              spellCheck={false}
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

/** @deprecated use SchemaFilterDialog */
export function DatabaseFilterDialog(props: {
  open: boolean;
  connectionName: string;
  databases: string[];
  initial: SchemaFilterState;
  onClose: () => void;
  onApply: (state: SchemaFilterState) => void;
}) {
  const { t } = useI18n();
  return (
    <SchemaFilterDialog
      open={props.open}
      title={t("database.filter.title", { name: props.connectionName })}
      items={props.databases}
      initial={props.initial}
      onClose={props.onClose}
      onApply={props.onApply}
    />
  );
}

export function createDefaultFilter(names: string[]): SchemaFilterState {
  return {
    orderedNames: [...names],
    visibleNames: new Set(names),
  };
}

export function mergeFilter(existing: SchemaFilterState | undefined, names: string[]): SchemaFilterState {
  if (!existing) {
    return createDefaultFilter(names);
  }

  const nameSet = new Set(names);
  const orderedNames = [
    ...existing.orderedNames.filter((name) => nameSet.has(name)),
    ...names.filter((name) => !existing.orderedNames.includes(name)),
  ];
  const visibleNames = new Set([...existing.visibleNames].filter((name) => nameSet.has(name)));
  if (visibleNames.size === 0) {
    names.forEach((name) => visibleNames.add(name));
  }

  return { orderedNames, visibleNames };
}

export function getVisibleItems<T extends { name: string }>(
  items: T[],
  filter: SchemaFilterState | undefined
): T[] {
  if (!filter) {
    return items;
  }

  const orderMap = new Map(filter.orderedNames.map((name, index) => [name, index]));
  return items
    .filter((item) => filter.visibleNames.has(item.name))
    .sort((a, b) => (orderMap.get(a.name) ?? 9999) - (orderMap.get(b.name) ?? 9999));
}

/** 按侧栏过滤规则返回可见的数据库名列表（保持排序）。 */
export function getVisibleNames(names: string[], filter: SchemaFilterState | undefined): string[] {
  return getVisibleItems(
    names.map((name) => ({ name })),
    filter,
  ).map((item) => item.name);
}

/** @deprecated use getVisibleItems */
export const getVisibleDatabases = getVisibleItems;

export function makeTableFilterKey(connId: string, dbName: string): string {
  return `${connId}:${dbName}`;
}
