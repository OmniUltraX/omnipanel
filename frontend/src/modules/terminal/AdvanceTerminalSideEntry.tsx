import { useI18n } from "@/i18n";

export type AdvanceTerminalSideEntryTab = {
  id: string;
  label: string;
};

/**
 * 终端侧栏顶部入口：始终显示，展开时当前项高亮；再点当前项收起。
 */
export function AdvanceTerminalSideEntry({
  tabs,
  activeId,
  expanded,
  onSelect,
}: {
  tabs: AdvanceTerminalSideEntryTab[];
  activeId: string | null;
  expanded: boolean;
  onSelect: (id: string) => void;
}) {
  const { t } = useI18n();

  return (
    <div
      className="advance-terminal-side-entry"
      role="toolbar"
      aria-label={t("terminal.sideTabs.rail")}
    >
      {tabs.map((tab) => {
        const isActive = expanded && activeId === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            className={`advance-terminal-side-entry-btn${isActive ? " is-active" : ""}`}
            onClick={() => onSelect(tab.id)}
            title={tab.label}
            aria-label={tab.label}
            aria-pressed={isActive}
          >
            <span className="advance-terminal-side-entry-label">{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}
