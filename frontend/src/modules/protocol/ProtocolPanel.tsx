import { useCallback, useEffect, useMemo } from "react";
import { useLocation } from "react-router-dom";
import { ModuleSegmentDock } from "../../components/dock";
import { ModuleWorkspaceLayout } from "../../components/workspace";
import { WorkspaceEmptyPage } from "../../components/ui/WorkspaceEmptyPage";
import { useI18n } from "../../i18n";
import { getVisibleProtocolTabs, type ProtocolTabKey } from "../../lib/protocolLabConfig";
import { useSettingsStore } from "../../stores/settingsStore";
import { useProtocolTopbarStore } from "../../stores/protocolTopbarStore";
import { useProtocolWorkspaceStore } from "../../stores/protocolWorkspaceStore";
import { useProtocolLabEntryStore } from "../../stores/protocolLabEntryStore";
import { ProtocolHttpSidebar } from "./ProtocolHttpSidebar";
import { ProtocolSessionPanel } from "./ProtocolSessionPanel";
import { useProtocolAddMenu } from "./useProtocolAddMenu";
import { useProtocolPickerHandler } from "./useProtocolPickerHandler";
import { ProtocolHttpProvider, useProtocolHttpOptional } from "./ProtocolHttpContext";

function ProtocolPanelInner() {
  const { t } = useI18n();
  const location = useLocation();
  const isActiveRoute = location.pathname === "/module/protocol";
  const protocolLabTabs = useSettingsStore((s) => s.protocolLabTabs);
  const savedRequests = useProtocolHttpOptional()?.savedRequests ?? [];
  const labEntries = useProtocolLabEntryStore((s) => s.entries);

  const tabs = useProtocolWorkspaceStore((s) => s.tabs);
  const activeTabId = useProtocolWorkspaceStore((s) => s.activeTabId);
  const savedLayout = useProtocolWorkspaceStore((s) => s.savedLayout);
  const setActiveTabId = useProtocolWorkspaceStore((s) => s.setActiveTabId);
  const closeTab = useProtocolWorkspaceStore((s) => s.closeTab);
  const setSavedLayout = useProtocolWorkspaceStore((s) => s.setSavedLayout);
  const updateTabLabel = useProtocolWorkspaceStore((s) => s.updateTabLabel);

  const requestNewTabPicker = useProtocolTopbarStore((s) => s.requestNewTabPicker);

  const { selectableProtocols } = useProtocolAddMenu();
  useProtocolPickerHandler();

  const visibleProtocols = useMemo(
    () => getVisibleProtocolTabs(protocolLabTabs),
    [protocolLabTabs],
  );

  useEffect(() => {
    for (const tab of tabs) {
      if (tab.protocol !== "http" || !tab.resourceId) continue;
      const req = savedRequests.find((entry) => entry.id === tab.resourceId);
      if (req && req.name !== tab.label) {
        updateTabLabel(tab.id, req.name);
      }
    }
  }, [savedRequests, tabs, updateTabLabel]);

  useEffect(() => {
    for (const tab of tabs) {
      if (tab.protocol === "http" || !tab.resourceId) continue;
      const entry = labEntries.find((item) => item.id === tab.resourceId);
      if (entry && entry.name !== tab.label) {
        updateTabLabel(tab.id, entry.name);
      }
    }
  }, [labEntries, tabs, updateTabLabel]);

  useEffect(() => {
    if (!activeTabId) return;
    const active = tabs.find((tab) => tab.id === activeTabId);
    if (!active) {
      const nextId = tabs[tabs.length - 1]?.id ?? null;
      if (nextId !== activeTabId) {
        setActiveTabId(nextId);
      }
      return;
    }
    if (!visibleProtocols.includes(active.protocol)) {
      const replacement = tabs.find((tab) => visibleProtocols.includes(tab.protocol));
      if (replacement && replacement.id !== activeTabId) {
        setActiveTabId(replacement.id);
      }
    }
  }, [activeTabId, setActiveTabId, tabs, visibleProtocols]);

  const dockTabs = useMemo(
    () =>
      tabs.map((tab) => ({
        id: tab.id,
        label: tab.label,
        closable: true,
        panelType: `protocol-${tab.protocol}`,
        tooltip: tab.label,
      })),
    [tabs],
  );

  const renderPanel = useCallback(
    (tabId: string) => {
      const tab = tabs.find((item) => item.id === tabId);
      if (!tab) return null;
      return (
        <ProtocolSessionPanel
          tabId={tabId}
          protocol={tab.protocol}
          resourceId={tab.resourceId}
          enabled={isActiveRoute && activeTabId === tabId}
        />
      );
    },
    [activeTabId, isActiveRoute, tabs],
  );

  const emptyQuickActions = useMemo(
    () =>
      selectableProtocols.map((protocol) => ({
        id: protocol,
        label: t(`protocol.tabs.${protocol}`),
        onClick: () => requestNewTabPicker(protocol),
      })),
    [requestNewTabPicker, selectableProtocols, t],
  );

  const addTabConfig = useMemo(
    () => ({
      show: isActiveRoute,
      title: t("protocol.actions.newTab"),
      onAdd: requestNewTabPicker,
    }),
    [isActiveRoute, requestNewTabPicker, t],
  );

  return (
    <ModuleWorkspaceLayout
      layoutKey="protocol"
      className="protocol-module-layout"
      leftColumnTitle={t("routes.protocol")}
      leftSidebar={<ProtocolHttpSidebar />}
    >
      <ModuleSegmentDock
        className="protocol-module-dock"
        variant="workspace"
        dockScope="protocol-workspace"
        moduleTitle={t("routes.protocol")}
        enabled={isActiveRoute}
        windowControl
        tabs={dockTabs}
        activeTabId={activeTabId ?? ""}
        onActiveTabChange={setActiveTabId}
        onCloseTab={closeTab}
        savedLayout={savedLayout}
        onSavedLayoutChange={setSavedLayout}
        renderPanel={renderPanel}
        addTabConfig={addTabConfig}
        emptyContent={
          <WorkspaceEmptyPage
            title={t("routes.protocol")}
            prompt={t("protocol.newTab.emptyPrompt")}
            actionList={
              emptyQuickActions.length > 0
                ? {
                    title: t("protocol.newTab.title"),
                    items: emptyQuickActions,
                  }
                : undefined
            }
          />
        }
      />
    </ModuleWorkspaceLayout>
  );
}

export function ProtocolPanel() {
  return (
    <ProtocolHttpProvider>
      <ProtocolPanelInner />
    </ProtocolHttpProvider>
  );
}
