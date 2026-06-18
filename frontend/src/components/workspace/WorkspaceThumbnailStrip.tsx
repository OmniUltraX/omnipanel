import { useCallback } from "react";
import { WorkspaceTabPreview } from "./WorkspaceTabPreview";
import { WorkspaceCompactFloatingChrome } from "./WorkspaceCompactFloatingChrome";
import type { WorkspaceDockTab } from "../../stores/workspaceBottomDockStore";
import { useBottomPanelStore } from "../../stores/bottomPanelStore";

interface WorkspaceThumbnailStripProps {
  tabs: WorkspaceDockTab[];
  activeTabId: string;
  onSelectTab: (tabId: string) => void;
}

export function WorkspaceThumbnailStrip({
  tabs,
  activeTabId,
  onSelectTab,
}: WorkspaceThumbnailStripProps) {
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
    <div className="workspace-thumbnail-strip">
      <WorkspaceCompactFloatingChrome />
      <div className="workspace-thumbnail-strip__scroll" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === activeTabId}
            className={`workspace-thumbnail-card${tab.id === activeTabId ? " is-active" : ""}`}
            onClick={() => handleSelect(tab.id)}
          >
            <WorkspaceTabPreview tab={tab} active={tab.id === activeTabId} />
          </button>
        ))}
      </div>
    </div>
  );
}
