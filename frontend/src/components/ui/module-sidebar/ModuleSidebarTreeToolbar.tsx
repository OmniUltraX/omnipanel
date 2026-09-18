import { useI18n } from "@/i18n";
import { SidebarRefreshIcon } from "./SidebarRefreshIcon";

export type ModuleSidebarTreeToolbarProps = {
  onExpandAll?: () => void;
  onCollapseAll?: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  expandDisabled?: boolean;
  collapseDisabled?: boolean;
  refreshDisabled?: boolean;
};

function ExpandAllIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      width="12"
      height="12"
      aria-hidden
    >
      <path d="M8 8l4 4 4-4" />
      <path d="M8 13l4 4 4-4" />
    </svg>
  );
}

function CollapseAllIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      width="12"
      height="12"
      aria-hidden
    >
      <path d="M8 16l4-4 4 4" />
      <path d="M8 11l4-4 4 4" />
    </svg>
  );
}

/**
 * L1 段头树工具条：刷新 + 展开/折叠二选一，顺序固定。
 *
 * 展开与折叠不同时显示：只要还有已展开节点就只显示折叠，
 * 全收起（或空树）才显示展开，避免两个反义按钮并排占用段头。
 * 刷新无对应能力时置灰而非缺失，保证各模块段头按钮位横向对齐。
 * 折叠 path 复用数据库段头（`SchemaBrowser`），展开为其垂直翻转；
 * 刷新语义复用 `DockerTreeRefreshButton`（busy 旋转、点击阻止冒泡）。
 */
export function ModuleSidebarTreeToolbar({
  onExpandAll,
  onCollapseAll,
  onRefresh,
  refreshing = false,
  expandDisabled = false,
  collapseDisabled = false,
  refreshDisabled = false,
}: ModuleSidebarTreeToolbarProps) {
  const { t } = useI18n();
  const refreshTitle = t("common.refresh");
  const expandTitle = t("sidebarTree.expandAll");
  const collapseTitle = t("sidebarTree.collapseAll");

  // 展开/折叠二选一：有可收节点时只显示折叠，否则显示展开（空树时为置灰占位）。
  const showCollapse = Boolean(onCollapseAll) && !collapseDisabled;

  return (
    <span className="module-sidebar-toolbar" role="toolbar">
      <button
        type="button"
        className={`tree-action-btn${refreshing ? " tree-action-btn--busy" : ""}`}
        title={refreshTitle}
        aria-label={refreshTitle}
        disabled={!onRefresh || refreshDisabled || refreshing}
        onClick={(event) => {
          event.stopPropagation();
          onRefresh?.();
        }}
      >
        <SidebarRefreshIcon />
      </button>
      {showCollapse ? (
        <button
          type="button"
          className="tree-action-btn"
          title={collapseTitle}
          aria-label={collapseTitle}
          onClick={(event) => {
            event.stopPropagation();
            onCollapseAll?.();
          }}
        >
          <CollapseAllIcon />
        </button>
      ) : (
        <button
          type="button"
          className="tree-action-btn"
          title={expandTitle}
          aria-label={expandTitle}
          disabled={!onExpandAll || expandDisabled}
          onClick={(event) => {
            event.stopPropagation();
            onExpandAll?.();
          }}
        >
          <ExpandAllIcon />
        </button>
      )}
    </span>
  );
}
