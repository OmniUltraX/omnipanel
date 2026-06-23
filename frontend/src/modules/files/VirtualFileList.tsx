import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { FileEntryIcon } from "../../components/ui/FileEntryIcon";
import { useI18n } from "../../i18n";
import type { FileEntry } from "../../ipc/bindings";
import { fileTypeLabel, formatFileSize, formatFileTime } from "./utils";

const LIST_ROW_HEIGHT = 32;
const GRID_MIN_COLUMN = 100;
const GRID_GAP = 8;
const GRID_ROW_HEIGHT = 88;

export interface VirtualFileListProps {
  entries: FileEntry[];
  selected: FileEntry | null;
  /** Change this value (e.g. `${path}|${connId}`) to reset scroll to top. */
  scrollResetSignal?: string;
  onActivate: (entry: FileEntry) => void;
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void;
  onDownload: (entry: FileEntry) => void;
}

export function VirtualFileList({
  entries,
  selected,
  scrollResetSignal,
  onActivate,
  onContextMenu,
  onDownload,
}: VirtualFileListProps) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [scrollResetSignal]);
  const rowVirtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LIST_ROW_HEIGHT,
    overscan: 16,
  });
  const virtualItems = rowVirtualizer.getVirtualItems();
  const paddingTop = virtualItems.length > 0 ? virtualItems[0]!.start : 0;
  const paddingBottom =
    virtualItems.length > 0
      ? rowVirtualizer.getTotalSize() - virtualItems[virtualItems.length - 1]!.end
      : 0;

  const renderRow = useCallback(
    (index: number) => {
      const entry = entries[index];
      if (!entry) return null;
      const isDir = entry.kind === "dir";
      return (
        <div
          key={entry.path}
          className={`fm-file-row${selected?.path === entry.path ? " selected" : ""}`}
          onClick={() => onActivate(entry)}
          onContextMenu={(e) => onContextMenu(e, entry)}
          onDoubleClick={() => !isDir && void onDownload(entry)}
        >
          <span className={`fm-file-icon${isDir ? " folder" : ""}`}>
            <FileEntryIcon type={isDir ? "dir" : "file"} />
          </span>
          <span className="fm-file-name">{entry.name}</span>
          <span className="fm-file-size">{isDir ? "—" : formatFileSize(entry.size)}</span>
          <span className="fm-file-type">{fileTypeLabel(entry)}</span>
          <span className="fm-file-modified">{formatFileTime(entry.modified)}</span>
          <span className="fm-file-perms">{entry.permissions ?? "—"}</span>
        </div>
      );
    },
    [entries, selected?.path, onActivate, onContextMenu, onDownload],
  );

  return (
    <>
      <div className="fm-table-header">
        <span className="fm-th-name">{t("files.columns.name")}</span>
        <span className="fm-th-size">{t("files.columns.size")}</span>
        <span className="fm-th-type">{t("files.columns.type")}</span>
        <span className="fm-th-modified">{t("files.columns.modified")}</span>
        <span className="fm-th-perms">{t("files.columns.permissions")}</span>
      </div>
      <div className="fm-file-list" ref={scrollRef}>
        {paddingTop > 0 && <div style={{ height: paddingTop }} />}
        {virtualItems.map((item) => renderRow(item.index))}
        {paddingBottom > 0 && <div style={{ height: paddingBottom }} />}
      </div>
    </>
  );
}

export interface VirtualFileGridProps {
  entries: FileEntry[];
  selected: FileEntry | null;
  /** Change this value (e.g. `${path}|${connId}`) to reset scroll to top. */
  scrollResetSignal?: string;
  onActivate: (entry: FileEntry) => void;
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void;
  onDownload: (entry: FileEntry) => void;
}

export function VirtualFileGrid({
  entries,
  selected,
  scrollResetSignal,
  onActivate,
  onContextMenu,
  onDownload,
}: VirtualFileGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [scrollResetSignal]);
  const [columns, setColumns] = useState(1);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      const width = el.clientWidth - 24;
      const cols = Math.max(1, Math.floor((width + GRID_GAP) / (GRID_MIN_COLUMN + GRID_GAP)));
      setColumns((prev) => (prev === cols ? prev : cols));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rowCount = useMemo(() => Math.ceil(entries.length / columns), [entries.length, columns]);

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => GRID_ROW_HEIGHT,
    overscan: 4,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const paddingTop = virtualRows.length > 0 ? virtualRows[0]!.start : 0;
  const paddingBottom =
    virtualRows.length > 0
      ? rowVirtualizer.getTotalSize() - virtualRows[virtualRows.length - 1]!.end
      : 0;

  const innerStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: `repeat(${columns}, minmax(${GRID_MIN_COLUMN}px, 1fr))`,
    gap: GRID_GAP,
    alignContent: "start",
  };

  const renderRow = useCallback(
    (rowIndex: number) => {
      const start = rowIndex * columns;
      const items = entries.slice(start, start + columns);
      return (
        <div key={rowIndex} className="fm-grid-row" style={{ ...innerStyle }}>
          {items.map((entry) => {
            const isDir = entry.kind === "dir";
            return (
              <div
                key={entry.path}
                className={`fm-grid-item${selected?.path === entry.path ? " selected" : ""}`}
                onClick={() => onActivate(entry)}
                onContextMenu={(e) => onContextMenu(e, entry)}
                onDoubleClick={() => !isDir && void onDownload(entry)}
              >
                <span className={`grid-icon${isDir ? " folder" : ""}`}>
                  <FileEntryIcon type={isDir ? "dir" : "file"} />
                </span>
                <span className="grid-name">{entry.name}</span>
                <span className="grid-size">{isDir ? "—" : formatFileSize(entry.size)}</span>
              </div>
            );
          })}
        </div>
      );
    },
    [columns, entries, selected?.path, onActivate, onContextMenu, onDownload],
  );

  return (
    <div className="fm-grid" ref={scrollRef}>
      {paddingTop > 0 && <div style={{ height: paddingTop }} />}
      {virtualRows.map((item) => renderRow(item.index))}
      {paddingBottom > 0 && <div style={{ height: paddingBottom }} />}
    </div>
  );
}