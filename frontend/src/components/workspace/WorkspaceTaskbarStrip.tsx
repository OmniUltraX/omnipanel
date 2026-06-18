import { useCallback } from "react";
import { WorkspaceSwitcher } from "../shell/WorkspaceSwitcher";
import { useBottomPanelStore } from "../../stores/bottomPanelStore";
import type { WorkspaceDockTab } from "../../stores/workspaceBottomDockStore";
import { resolveWorkspaceTabPreview } from "../../lib/workspaceTabPreview";

interface WorkspaceTaskbarStripProps {
  tabs: WorkspaceDockTab[];
  activeTabId: string;
  onSelectTab: (tabId: string) => void;
}

function TaskbarTabButton({
  tab,
  active,
  onSelect,
}: {
  tab: WorkspaceDockTab;
  active: boolean;
  onSelect: () => void;
}) {
  const preview = resolveWorkspaceTabPreview(tab);
  const statusLabel =
    preview.status === "connected"
      ? "已连接"
      : preview.status === "running"
        ? "运行中"
        : preview.status === "connecting"
          ? "连接中"
          : preview.status ?? null;

  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`workspace-taskbar-tab${active ? " is-active" : ""}`}
      onClick={onSelect}
      title={tab.label}
    >
      <span className="workspace-taskbar-tab__kind" data-kind={preview.kind}>
        {preview.source}
      </span>
      <span className="workspace-taskbar-tab__label">{tab.label}</span>
      {statusLabel ? (
        <span
          className={`workspace-taskbar-tab__status workspace-taskbar-tab__status--${preview.status}`}
        >
          {statusLabel}
        </span>
      ) : null}
    </button>
  );
}

/** 固定高度任务栏：内联切换器 + Tab 条（全屏按钮由 WorkspacePanel frame 承载） */
export function WorkspaceTaskbarStrip({
  tabs,
  activeTabId,
  onSelectTab,
}: WorkspaceTaskbarStripProps) {
  const enterWorkspaceFullscreen = useBottomPanelStore(
    (state) => state.enterWorkspaceFullscreen,
  );

  const handleSelect = useCallback(
    (tabId: string) => {
      onSelectTab(tabId);
      enterWorkspaceFullscreen();
    },
    [enterWorkspaceFullscreen, onSelectTab],
  );

  return (
    <div className="workspace-taskbar-strip">
      <div className="workspace-taskbar-strip__switcher drag-ignore">
        <WorkspaceSwitcher placement="below" showHome={false} compact />
      </div>
      <div className="workspace-taskbar-strip__tabs" role="tablist">
        {tabs.map((tab) => (
          <TaskbarTabButton
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            onSelect={() => handleSelect(tab.id)}
          />
        ))}
      </div>
    </div>
  );
}
