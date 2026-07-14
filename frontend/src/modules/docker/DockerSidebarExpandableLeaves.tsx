import { Fragment, useState, type ReactNode } from "react";
import { useI18n } from "../../i18n";

/** 侧栏展开分类默认最多挂载的叶子数；超出可点「展开更多」 */
export const DOCKER_SIDEBAR_LEAF_SOFT_LIMIT = 80;

type DockerSidebarExpandableLeavesProps<T> = {
  items: T[];
  softLimit?: number;
  getKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => ReactNode;
};

/**
 * 大列表软截断：折叠分类本就不挂叶子；展开时超过 softLimit 只挂前 N 项，避免一次挂载数百节点。
 */
export function DockerSidebarExpandableLeaves<T>({
  items,
  softLimit = DOCKER_SIDEBAR_LEAF_SOFT_LIMIT,
  getKey,
  renderItem,
}: DockerSidebarExpandableLeavesProps<T>) {
  const { t } = useI18n();
  const [showAll, setShowAll] = useState(false);
  const needsTruncate = items.length > softLimit;
  const visible = needsTruncate && !showAll ? items.slice(0, softLimit) : items;
  const remaining = items.length - visible.length;

  return (
    <>
      {visible.map((item, index) => (
        <Fragment key={getKey(item, index)}>{renderItem(item, index)}</Fragment>
      ))}
      {needsTruncate ? (
        <button
          type="button"
          className="docker-sidebar-tree__show-more"
          onClick={() => setShowAll((current) => !current)}
        >
          {showAll
            ? t("docker.sidebar.treeCollapseLeaves")
            : t("docker.sidebar.treeShowMoreLeaves", { count: remaining })}
        </button>
      ) : null}
    </>
  );
}
