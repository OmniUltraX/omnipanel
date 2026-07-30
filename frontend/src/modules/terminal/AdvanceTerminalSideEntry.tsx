import { useI18n } from "@/i18n";
import { shortcutTitle } from "@/lib/shortcutTitle";
import { useShortcutsStore } from "@/stores/shortcutsStore";

export type AdvanceTerminalSideEntryTab = {
  id: string;
  label: string;
};

const SIDE_TAB_SHORTCUT: Record<string, string> = {
  monitor: "toggle-terminal-side-monitor",
  processes: "toggle-terminal-side-monitor",
  files: "toggle-terminal-side-files",
  sftp: "toggle-terminal-side-sftp",
  tunnel: "toggle-terminal-side-tunnel",
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
  useShortcutsStore((s) => s.overrides);

  return (
    <div
      className="advance-terminal-side-entry"
      role="toolbar"
      aria-label={t("terminal.sideTabs.rail")}
    >
      {tabs.map((tab) => {
        const isActive = expanded && activeId === tab.id;
        const shortcutId = SIDE_TAB_SHORTCUT[tab.id];
        const title = shortcutId ? shortcutTitle(tab.label, shortcutId) : tab.label;
        return (
          <button
            key={tab.id}
            type="button"
            className={`advance-terminal-side-entry-btn${isActive ? " is-active" : ""}`}
            onClick={() => onSelect(tab.id)}
            title={title}
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
