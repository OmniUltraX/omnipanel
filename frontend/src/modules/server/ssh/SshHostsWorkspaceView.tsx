import { useCallback, useMemo, useRef } from "react";
import { DockWorkspace } from "../../../components/dock";
import { usePanelLayoutStore } from "../../../stores/panelLayoutStore";
import { useI18n } from "../../../i18n";
import type { WorkspaceResource } from "../../../lib/resourceRegistry";
import { HostDetailPanel } from "./components/HostDetailPanel";
import { useSshHostWorkspace } from "./hooks/useSshHostWorkspace";
import { SshHostSidebar } from "./SshHostSidebar";
import { SshSidebarLinkageProvider } from "./SshSidebarLinkageContext";
import { SshWorkspaceDock } from "./SshWorkspaceDock";

const LEFT_MIN_PX = 240;
const LAYOUT_PERSIST_KEY = "ssh-hosts";

export interface SshHostsWorkspaceViewProps {
  resources: WorkspaceResource[];
}

export function SshHostsWorkspaceView({ resources }: SshHostsWorkspaceViewProps) {
  const { t } = useI18n();
  const {
    workspaceTabs,
    activeTabId,
    activeHostId,
    dockTabs,
    dockLayout,
    setDockLayout,
    activateTab,
    handleSelectHost,
    handleCloseTab,
    handleDockTabDoubleClick,
  } = useSshHostWorkspace(resources);

  const savedSize = usePanelLayoutStore((s) => s.leftSizes[LAYOUT_PERSIST_KEY]);
  const setLeftSize = usePanelLayoutStore((s) => s.setLeftSize);
  const leftSizePx =
    typeof savedSize === "number" && savedSize >= LEFT_MIN_PX ? savedSize : undefined;
  const pendingLeftSizeRef = useRef<number | null>(null);

  const handleLeftResize = useCallback((sizePx: number) => {
    pendingLeftSizeRef.current = sizePx;
  }, []);

  const handleLeftLayoutChanged = useCallback(() => {
    const size = pendingLeftSizeRef.current;
    if (size == null) return;
    if (size < LEFT_MIN_PX) {
      pendingLeftSizeRef.current = null;
      return;
    }
    setLeftSize(LAYOUT_PERSIST_KEY, size);
    pendingLeftSizeRef.current = null;
  }, [setLeftSize]);

  const sidebarLinkageValue = useMemo(
    () => ({
      activeHostId,
    }),
    [activeHostId],
  );

  const renderDockPanel = useCallback(
    (tabId: string) => {
      const tab = workspaceTabs.find((item) => item.id === tabId);
      if (!tab) return null;
      return <HostDetailPanel hostId={tab.hostId} />;
    },
    [workspaceTabs],
  );

  return (
    <SshSidebarLinkageProvider value={sidebarLinkageValue}>
      <DockWorkspace
        className="ssh-hosts-workspace"
        leftPreset="host"
        leftSizePx={leftSizePx}
        leftMinPx={LEFT_MIN_PX}
        onLeftResize={handleLeftResize}
        onLeftLayoutChanged={handleLeftLayoutChanged}
        left={<SshHostSidebar resources={resources} onSelectHost={handleSelectHost} />}
        main={
          <SshWorkspaceDock
            dockTabs={dockTabs}
            activeTabId={activeTabId}
            onActiveTabChange={activateTab}
            onCloseTab={handleCloseTab}
            dockLayout={dockLayout}
            onDockLayoutChange={setDockLayout}
            renderDockPanel={renderDockPanel}
            onTabDoubleClick={handleDockTabDoubleClick}
            emptyPrompt={t("ssh.empty.selectHost")}
          />
        }
      />
    </SshSidebarLinkageProvider>
  );
}
