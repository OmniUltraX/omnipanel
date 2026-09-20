/**
 * 侧栏计数徽标：替代散落的 `server-tree-badge` / `badge badge-muted`。
 * 幽灵灰底、等宽数字，全模块同字号同圆角。
 */
export function SidebarCountBadge({
  count,
  title,
}: {
  count: number | string;
  title?: string;
}) {
  return (
    <span className="sidebar-count-badge" title={title ?? String(count)}>
      {count}
    </span>
  );
}
