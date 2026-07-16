import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { RedisKeyListRow } from "./redisKeyBrowserRows";
import {
  REDIS_KEY_ROW_HEIGHT,
  REDIS_KEY_VIRTUALIZE_THRESHOLD,
} from "./redisKeyBrowserRows";

interface RedisKeyBrowserListProps {
  rows: RedisKeyListRow[];
  selectedKey: string | null;
  onToggleFolder: (folderId: string) => void;
  onSelectKey: (key: string) => void;
  /** 接近底部时回调（自动加载 / 填充视口） */
  onNearBottom?: () => void;
  loadingMore?: boolean;
}

const NEAR_BOTTOM_PX = 80;

export function RedisKeyBrowserList({
  rows,
  selectedKey,
  onToggleFolder,
  onSelectKey,
  onNearBottom,
  loadingMore = false,
}: RedisKeyBrowserListProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const useVirtual = rows.length > REDIS_KEY_VIRTUALIZE_THRESHOLD;

  const rowVirtualizer = useVirtualizer({
    count: useVirtual ? rows.length : 0,
    getScrollElement: () => (useVirtual ? scrollRef.current : null),
    estimateSize: () => REDIS_KEY_ROW_HEIGHT,
    getItemKey: (index) => rowsRef.current[index]?.key ?? index,
    overscan: 16,
  });

  useEffect(() => {
    if (!onNearBottom) {
      return;
    }
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const check = () => {
      if (el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX) {
        onNearBottom();
      }
    };
    // 内容不足以撑满视口时也尝试继续加载
    const raf = requestAnimationFrame(() => {
      if (el.scrollHeight <= el.clientHeight + NEAR_BOTTOM_PX) {
        onNearBottom();
      }
    });
    el.addEventListener("scroll", check, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("scroll", check);
    };
  }, [onNearBottom, rows.length, loadingMore]);

  const renderRow = (row: RedisKeyListRow) => {
    if (row.kind === "folder") {
      return (
        <button
          type="button"
          className="redis-key-tree-row redis-key-tree-row--folder"
          style={{ paddingLeft: 8 + row.depth * 14 }}
          onClick={() => onToggleFolder(row.key)}
        >
          <span className="redis-key-tree-chevron">{row.expanded ? "▾" : "▸"}</span>
          <span className="redis-key-tree-folder-label">
            {row.segment} ({row.count})
          </span>
        </button>
      );
    }
    const active = selectedKey === row.entry.key;
    return (
      <button
        type="button"
        className={`redis-key-tree-row redis-key-tree-row--key${active ? " active" : ""}`}
        style={{ paddingLeft: 8 + row.depth * 14 }}
        onClick={() => onSelectKey(row.entry.key)}
      >
        <span className="redis-key-tree-key-label">{row.segment}</span>
        <span className="redis-key-type-badge redis-key-type-badge--sm">
          {row.entry.keyType}
        </span>
      </button>
    );
  };

  if (!useVirtual) {
    return (
      <div className="redis-query-tree" ref={scrollRef}>
        {rows.map((row) => (
          <div key={row.key} className="redis-key-tree-row-wrap">
            {renderRow(row)}
          </div>
        ))}
        {loadingMore ? (
          <div className="redis-query-tree-loading">…</div>
        ) : null}
      </div>
    );
  }

  const virtualRows = rowVirtualizer.getVirtualItems();

  return (
    <div className="redis-query-tree redis-query-tree--virtual" ref={scrollRef}>
      <div
        className="redis-query-tree-virtual-inner"
        style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}
      >
        {virtualRows.map((virtualRow) => {
          const row = rows[virtualRow.index];
          if (!row) {
            return null;
          }
          return (
            <div
              key={row.key}
              data-index={virtualRow.index}
              className="redis-key-tree-row-wrap redis-key-tree-row-wrap--virtual"
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: virtualRow.size,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              {renderRow(row)}
            </div>
          );
        })}
      </div>
      {loadingMore ? (
        <div className="redis-query-tree-loading redis-query-tree-loading--overlay">…</div>
      ) : null}
    </div>
  );
}
