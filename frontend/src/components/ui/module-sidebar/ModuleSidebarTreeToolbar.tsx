import { useI18n } from "@/i18n";

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

function RefreshIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      width="12"
      height="12"
      aria-hidden
    >
      <path d="M2 8a6 6 0 0 1 10.5-3.9" />
      <path d="M14 2v3h-3" />
      <path d="M14 8a6 6 0 0 1-10.5 3.9" />
      <path d="M2 14v-3h3" />
    </svg>
  );
}

/**
 * L1 段头树工具条：刷新 → 一键展开 → 一键折叠，顺序固定。
 *
 * 无对应能力的树将按钮置灰而非缺失，保证各模块段头按钮位横向对齐。
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
        <RefreshIcon />
      </button>
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
      <button
        type="button"
        className="tree-action-btn"
        title={collapseTitle}
        aria-label={collapseTitle}
        disabled={!onCollapseAll || collapseDisabled}
        onClick={(event) => {
          event.stopPropagation();
          onCollapseAll?.();
        }}
      >
        <CollapseAllIcon />
      </button>
    </span>
  );
}
