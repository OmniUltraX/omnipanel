import { Fragment, type ReactNode } from "react";

type DockerSidebarExpandableLeavesProps<T> = {
  items: T[];
  /** @deprecated 已不再限制数量；保留参数以免破坏调用方 */
  softLimit?: number;
  getKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => ReactNode;
};

/**
 * 侧栏展开分类的叶子列表：全量挂载，由外层侧栏滚动。
 */
export function DockerSidebarExpandableLeaves<T>({
  items,
  getKey,
  renderItem,
}: DockerSidebarExpandableLeavesProps<T>) {
  return (
    <>
      {items.map((item, index) => (
        <Fragment key={getKey(item, index)}>{renderItem(item, index)}</Fragment>
      ))}
    </>
  );
}
