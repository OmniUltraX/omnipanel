import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { ContextMenu, type ContextMenuItem } from "../../components/ui/menu/ContextMenu";
import { ModuleSegmentDock } from "../../components/dock";
import { WorkspaceEmptyPage } from "../../components/ui/workspace/WorkspaceEmptyPage";
import { quickInput } from "../../lib/quickInput";
import { useI18n } from "../../i18n";
import { useProtocolHttpDockStore } from "../../stores/protocolHttpDockStore";
import { useProtocolTopbarStore } from "../../stores/protocolTopbarStore";
import { HttpPanel } from "./HttpPanel";
import { useProtocolHttp } from "./ProtocolHttpContext";
import { resolveHttpRequestUrl } from "./httpEnvironment";

function ProtocolHttpTopbarBridge() {
  const requestNewRequestPicker = useProtocolTopbarStore((s) => s.requestNewRequestPicker);
  const signal = useProtocolTopbarStore((state) => state.newRequestSignal);
  const prevSignalRef = useRef(signal);

  useEffect(() => {
    if (signal === prevSignalRef.current) return;
    prevSignalRef.current = signal;
    requestNewRequestPicker(null);
  }, [signal, requestNewRequestPicker]);

  return null;
}

/** 单个 HTTP 请求 Dock 面板；仅激活 Tab 渲染完整编辑器。 */
export function HttpRequestDockPanel({ requestId }: { requestId: string }) {
  const activeTabId = useProtocolHttpDockStore((state) => state.activeTabId);

  if (activeTabId !== requestId) {
    return <div className="http-panel http-panel--inactive" aria-hidden />;
  }

  return <HttpPanel />;
}

/** HTTP 协议工作区：请求 Tab + HttpRequestDockPanel（侧栏由 ProtocolPanel 提供）。 */
export function HttpRequestPanel({
  moduleTitle,
  enabled = true,
  windowControl = true,
}: {
  moduleTitle?: React.ReactNode;
  enabled?: boolean;
  windowControl?: boolean;
}) {
  const { t } = useI18n();
  const http = useProtocolHttp();
  const openTabIds = useProtocolHttpDockStore((state) => state.openTabIds);
  const activeTabId = useProtocolHttpDockStore((state) => state.activeTabId);
  const dockLayout = useProtocolHttpDockStore((state) => state.dockLayout);
  const recentClosed = useProtocolHttpDockStore((state) => state.recentClosed);
  const setActiveTabId = useProtocolHttpDockStore((state) => state.setActiveTabId);
  const closeTab = useProtocolHttpDockStore((state) => state.closeTab);
  const setDockLayout = useProtocolHttpDockStore((state) => state.setDockLayout);

  const [tabCtxMenu, setTabCtxMenu] = useState<{ x: number; y: number; tabId: string } | null>(
    null,
  );

  const handleRenameTab = useCallback(
    async (tabId: string) => {
      const req = http.savedRequests.find((entry) => entry.id === tabId);
      if (!req) return;
      const name = await quickInput({
        title: t("protocol.sidebar.renameRequestTitle"),
        defaultValue: req.name,
        validate: (value) => (value.trim() ? null : t("protocol.sidebar.folderNameRequired")),
      });
      if (!name) return;
      await http.renameSavedRequest(tabId, name.trim());
    },
    [http, t],
  );

  const tabCtxItems = useMemo((): ContextMenuItem[] => {
    if (!tabCtxMenu) return [];
    return [
      {
        id: "rename",
        label: t("protocol.sidebar.renameRequest"),
        onClick: () => void handleRenameTab(tabCtxMenu.tabId),
      },
    ];
  }, [handleRenameTab, tabCtxMenu, t]);

  const handleTabContextMenu = useCallback((event: MouseEvent, tabId: string) => {
    event.preventDefault();
    setTabCtxMenu({ x: event.clientX, y: event.clientY, tabId });
  }, []);

  const handleTabDoubleClick = useCallback(
    (tabId: string) => {
      void handleRenameTab(tabId);
    },
    [handleRenameTab],
  );

  const dockTabs = useMemo(
    () =>
      openTabIds.map((id) => {
        const req = http.savedRequests.find((entry) => entry.id === id);
        const fullUrl = req
          ? resolveHttpRequestUrl(req.url, req.environmentId ?? null, http.environments)
          : null;
        return {
          id,
          label: req?.name ?? t("protocol.sidebar.defaultRequestName"),
          panelType: "http-request",
          closable: true,
          tooltip: fullUrl?.trim() || req?.url?.trim() || req?.name,
        };
      }),
    [openTabIds, http.savedRequests, http.environments, t],
  );

  const handleActiveTabChange = useCallback(
    (tabId: string) => {
      setActiveTabId(tabId);
      const req = http.savedRequests.find((entry) => entry.id === tabId);
      if (req) {
        http.selectRequest(req);
      }
    },
    [http, setActiveTabId],
  );

  const handleCloseTab = useCallback(
    (tabId: string) => {
      closeTab(tabId);
      const nextActiveId = useProtocolHttpDockStore.getState().activeTabId;
      if (nextActiveId) {
        const req = http.savedRequests.find((entry) => entry.id === nextActiveId);
        if (req) {
          http.selectRequest(req);
          return;
        }
      }
      http.clearSelectedRequest();
    },
    [closeTab, http],
  );

  const renderDockPanel = useCallback(
    (tabId: string) => <HttpRequestDockPanel requestId={tabId} />,
    [],
  );

  const recentClosedActionItems = useMemo(
    () =>
      recentClosed
        .filter((entry) => http.savedRequests.some((req) => req.id === entry.requestId))
        .slice(0, 5)
        .map((entry) => {
          const req = http.savedRequests.find((item) => item.id === entry.requestId);
          return {
            id: entry.requestId,
            label: req?.name ?? t("protocol.sidebar.defaultRequestName"),
            meta: new Date(entry.closedAt).toLocaleString(),
            onClick: () => {
              if (req) {
                http.openRequestTab(req);
              }
            },
          };
        }),
    [recentClosed, http, t],
  );

  useEffect(() => {
    if (!activeTabId || openTabIds.includes(activeTabId)) return;
    setActiveTabId(openTabIds[openTabIds.length - 1] ?? null);
  }, [activeTabId, openTabIds, setActiveTabId]);

  useEffect(() => {
    const validIds = new Set(http.savedRequests.map((entry) => entry.id));
    const staleTabIds = openTabIds.filter((id) => !validIds.has(id));
    if (staleTabIds.length === 0) return;
    for (const tabId of staleTabIds) {
      useProtocolHttpDockStore.getState().removeTab(tabId);
    }
  }, [http.savedRequests, openTabIds]);

  return (
    <>
      <ProtocolHttpTopbarBridge />
      <ModuleSegmentDock
        className="protocol-workspace protocol-http-dock"
        variant="workspace"
        dockScope="protocol-http"
        moduleTitle={moduleTitle}
        enabled={enabled}
        windowControl={windowControl}
        tabs={dockTabs}
        activeTabId={activeTabId ?? ""}
        onActiveTabChange={handleActiveTabChange}
        onCloseTab={handleCloseTab}
        savedLayout={dockLayout}
        onSavedLayoutChange={setDockLayout}
        renderPanel={renderDockPanel}
        softRefreshKey={activeTabId ?? ""}
        onTabContextMenu={handleTabContextMenu}
        onTabDoubleClick={handleTabDoubleClick}
        emptyContent={
          <WorkspaceEmptyPage
            title={t("protocol.tabs.http")}
            prompt={t("protocol.http.workspaceEmpty")}
            actionList={
              recentClosedActionItems.length > 0
                ? {
                    title: t("protocol.http.recentClosed"),
                    items: recentClosedActionItems,
                  }
                : undefined
            }
          />
        }
      />

      {tabCtxMenu ? (
        <ContextMenu
          items={tabCtxItems}
          position={{ x: tabCtxMenu.x, y: tabCtxMenu.y }}
          onClose={() => setTabCtxMenu(null)}
        />
      ) : null}
    </>
  );
}
