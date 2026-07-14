import { Fragment, useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

/** 超过此数量启用虚拟滚动；小列表直接挂载，避免无意义的虚拟器开销 */
export const DOCKER_SIDEBAR_LEAF_VIRTUAL_THRESHOLD = 40;

/** 预估侧栏树行高（与 sidebar-tree.min-height + padding 对齐） */
const DOCKER_SIDEBAR_LEAF_ROW_ESTIMATE_PX = 28;

/** 虚拟列表可视区最大高度（约 12 行，其余滚动） */
const DOCKER_SIDEBAR_LEAF_VIEWPORT_MAX_PX = 336;

type DockerSidebarExpandableLeavesProps<T> = {
  items: T[];
  /** @deprecated 已由虚拟列表替代「展开更多」；保留参数以免破坏调用方 */
  softLimit?: number;
  getKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => ReactNode;
};

/**
 * 侧栏展开分类的叶子列表：小列表全量挂载；大列表用虚拟滚动替代「展开更多」。
 */
export function DockerSidebarExpandableLeaves<T>({
  items,
  getKey,
  renderItem,
}: DockerSidebarExpandableLeavesProps<T>) {
  const useVirtual = items.length > DOCKER_SIDEBAR_LEAF_VIRTUAL_THRESHOLD;
  const parentRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: useVirtual ? items.length : 0,
    getScrollElement: () => parentRef.current,
    estimateSize: () => DOCKER_SIDEBAR_LEAF_ROW_ESTIMATE_PX,
    overscan: 8,
  });

  if (!useVirtual) {
    return (
      <>
        {items.map((item, index) => (
          <Fragment key={getKey(item, index)}>{renderItem(item, index)}</Fragment>
        ))}
      </>
    );
  }

  const virtualRows = rowVirtualizer.getVirtualItems();

  return (
    <div
      ref={parentRef}
      className="docker-sidebar-tree__virtual-list"
      style={{ maxHeight: DOCKER_SIDEBAR_LEAF_VIEWPORT_MAX_PX }}
    >
      <div
        className="docker-sidebar-tree__virtual-list-inner"
        style={{ height: rowVirtualizer.getTotalSize() }}
      >
        {virtualRows.map((virtualRow) => {
          const item = items[virtualRow.index];
          if (item == null) return null;
          return (
            <div
              key={getKey(item, virtualRow.index)}
              className="docker-sidebar-tree__virtual-row"
              data-index={virtualRow.index}
              ref={rowVirtualizer.measureElement}
              style={{
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              {renderItem(item, virtualRow.index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
