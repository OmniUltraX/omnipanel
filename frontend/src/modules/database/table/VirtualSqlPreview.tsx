import { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useScopedSearchQuery } from "../../../components/ui/search/ScopedSearch";
import { getTextSearchMatchIndices } from "../../../lib/textSearchMatch";

const ROW_HEIGHT = 20;
const OVERSCAN = 24;

interface VirtualSqlPreviewProps {
  ddl: string;
}

/** 大 SQL 只读预览：按行虚拟滚动，避免 CodeMirror 全量解析卡死。 */
export function VirtualSqlPreview({ ddl }: VirtualSqlPreviewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const highlightQuery = useScopedSearchQuery();
  const needle = highlightQuery.trim();

  const lines = useMemo(() => ddl.split("\n"), [ddl]);

  const rowVirtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });

  const virtualItems = rowVirtualizer.getVirtualItems();

  return (
    <div className="table-ddl-viewer table-ddl-viewer--virtual">
      <div ref={scrollRef} className="virtual-sql-preview">
        <div
          className="virtual-sql-preview__inner"
          style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
        >
          {virtualItems.map((item) => {
            const text = lines[item.index] ?? "";
            const match = needle ? getTextSearchMatchIndices(text, needle).length > 0 : false;
            return (
              <div
                key={item.key}
                className={`virtual-sql-preview__row${match ? " is-match" : ""}`}
                style={{
                  height: `${item.size}px`,
                  transform: `translateY(${item.start}px)`,
                }}
              >
                <span className="virtual-sql-preview__gutter">{item.index + 1}</span>
                <span className="virtual-sql-preview__code">{text.length === 0 ? " " : text}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
