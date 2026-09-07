import { useCallback, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { ModuleSegmentDock, closeDockTabNow, openDockTabNow } from "../../components/dock";
import { ModuleWorkspaceLayout } from "../../components/workspace";
import { WorkspaceEmptyPage } from "../../components/ui/workspace/WorkspaceEmptyPage";
import { WorkbenchActionButton } from "../../components/ui/primitives/WorkbenchActionButton";
import {
  ContextMenu,
  buildTabCloseMenuItems,
  type TabContextMenuAction,
} from "../../components/ui/menu";
import {
  DiscoveryImportDialog,
  type DiscoveryPreviewRow,
} from "../../components/ui/DiscoveryImportDialog";
import { useI18n } from "../../i18n";
import { appConfirm } from "../../lib/appConfirm";
import {
  isDiscoverySkip,
  runDiscoveryProbe,
  type DiscoveryCandidates,
} from "../../lib/discoveryBus";
import { useModuleVisibility } from "../../lib/moduleVisibility";
import { parseModuleWindowParams } from "../../lib/moduleWindow";
import { manifestModuleCapabilities } from "../../lib/moduleCapabilities";
import { getPluginManifest } from "../../lib/pluginManifests";
import { getPluginModule } from "../../lib/pluginModuleRegistry";
import { showToast } from "../../stores/toastStore";
import { isPluginActivated, usePluginRuntimeStore } from "../../stores/pluginRuntimeStore";
import { useConnectionStore } from "../../stores/connectionStore";
import { useModuleDockStore } from "../../stores/moduleDockStore";
import { CONNECTION_TAG_KINDS } from "../tags/tagKinds";
import { passTagFilter, useModuleTagFilter } from "../tags/useModuleTagFilter";
import { ModuleCapabilityWorkbench } from "./ModuleCapabilityWorkbench";
import { ModuleTreeSidebar } from "./ModuleTreeSidebar";
import { ServiceConnectionDialog } from "./ServiceConnectionDialog";
import { importModuleServiceRows } from "./moduleDiscovery";
import {
  connectionNamespaceId,
  listServiceConnections,
  withConnectionNamespaceId,
} from "./serviceConnections";
import {
  namespaceIdFromSelect,
  namespaceSelectValue,
  useModuleNamespaces,
} from "./useModuleNamespaces";
import {
  makeModuleTreeKey,
  type ModuleDockOpenMode,
  type ModuleSidebarNavTarget,
} from "./moduleWorkspaceTabs";
import type { Connection } from "../../ipc/bindings";
import "./moduleHost.css";

export function PluginModuleHost({ moduleKey }: { moduleKey: string }) {
  const { t } = useI18n();
  const { active: moduleActive, suspended: moduleSuspended } = useModuleVisibility();
  usePluginRuntimeStore((s) => s.items);
  const desc = getPluginModule(moduleKey);
  const pluginId = desc?.pluginId ?? "";
  const manifest = pluginId ? getPluginManifest(pluginId) : null;
  const nameKey = desc?.labelI18nKey;
  const translated = nameKey ? t(nameKey) : moduleKey;
  const name =
    manifest?.displayName?.trim() ||
    (translated === nameKey ? moduleKey : translated);
  const activated = desc ? isPluginActivated(desc.pluginId) : false;
  const connections = useConnectionStore((s) => s.connections);
  const removeConn = useConnectionStore((s) => s.remove);
  const saveConn = useConnectionStore((s) => s.save);
  const tagAllowedIds = useModuleTagFilter(moduleKey, CONNECTION_TAG_KINDS);
  const services = useMemo(
    () =>
      listServiceConnections(connections, pluginId).filter((conn) =>
        passTagFilter(tagAllowedIds, conn.id),
      ),
    [connections, pluginId, tagAllowedIds],
  );
  const capabilities = useMemo(() => manifestModuleCapabilities(manifest), [manifest]);

  const dockTabs = useModuleDockStore((s) => s.tabs);
  const activeTabId = useModuleDockStore((s) => s.activeTabId);
  const dockLayout = useModuleDockStore((s) => s.dockLayout);
  const openTab = useModuleDockStore((s) => s.openTab);
  const closeTab = useModuleDockStore((s) => s.closeTab);
  const setActiveTabId = useModuleDockStore((s) => s.setActiveTabId);
  const setDockLayout = useModuleDockStore((s) => s.setDockLayout);
  const removeConnectionTabs = useModuleDockStore((s) => s.removeConnectionTabs);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editConnection, setEditConnection] = useState<Connection | undefined>();
  const [scanOpen, setScanOpen] = useState(false);
  const [scanRows, setScanRows] = useState<DiscoveryPreviewRow[]>([]);
  const [scanBusy, setScanBusy] = useState(false);
  const [namespaceId, setNamespaceId] = useState("");
  const [tabCtxMenu, setTabCtxMenu] = useState<{
    x: number;
    y: number;
    tabId: string;
    index: number;
  } | null>(null);

  const moduleTabs = useMemo(
    () => dockTabs.filter((tab) => tab.moduleKey === moduleKey),
    [dockTabs, moduleKey],
  );
  const serviceById = useMemo(() => new Map(services.map((conn) => [conn.id, conn])), [services]);

  useEffect(() => {
    const valid = new Set(services.map((conn) => conn.id));
    for (const tab of moduleTabs) {
      if (!valid.has(tab.connectionId)) removeConnectionTabs(tab.connectionId);
    }
  }, [moduleTabs, removeConnectionTabs, services]);

  const activeTab = moduleTabs.find((tab) => tab.id === activeTabId) ?? moduleTabs[0] ?? null;
  const selected = activeTab ? (serviceById.get(activeTab.connectionId) ?? null) : null;
  const hasNamespaceCap = capabilities.some((cap) => cap.id === "namespace");
  const namespaces = useModuleNamespaces(pluginId, selected);

  const standalone = parseModuleWindowParams()?.moduleKey === moduleKey;
  // 与内建模块一致：用 Overlay ModuleVisibility 判活，禁止 useLocation 订阅
  const isActiveRoute = standalone || moduleActive;
  const moduleLive = standalone || (isActiveRoute && !moduleSuspended);

  useEffect(() => {
    if (!selected) {
      setNamespaceId("");
      return;
    }
    setNamespaceId(connectionNamespaceId(selected));
  }, [selected?.id]);

  const persistNamespace = useCallback(
    (nextId: string) => {
      setNamespaceId(nextId);
      if (!selected) return;
      if (connectionNamespaceId(selected) === nextId) return;
      void saveConn(withConnectionNamespaceId(selected, nextId));
    },
    [saveConn, selected],
  );

  const capabilityLabel = useCallback(
    (id: string) => {
      if (id === "overview") return t("moduleHost.overview");
      const declared = capabilities.find((cap) => cap.id === id)?.label?.trim();
      if (declared) return declared;
      const key = `moduleHost.capability.${id}`;
      const label = t(key);
      return label === key ? id : label;
    },
    [capabilities, t],
  );

  const handleNavigate = useCallback(
    (target: ModuleSidebarNavTarget, mode: ModuleDockOpenMode = "preview") => {
      openDockTabNow({
        applyTabSync: () => openTab(moduleKey, target.connectionId, target.capabilityId, mode),
      });
    },
    [moduleKey, openTab],
  );

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("omnipanel.module.pendingConnectionId");
      if (!raw) return;
      const pending = JSON.parse(raw) as { moduleKey?: string; connectionId?: string };
      if (pending.moduleKey !== moduleKey || !pending.connectionId) return;
      sessionStorage.removeItem("omnipanel.module.pendingConnectionId");
      handleNavigate({ connectionId: pending.connectionId, capabilityId: "overview" }, "permanent");
    } catch {
      /* ignore */
    }
  }, [handleNavigate, moduleKey]);

  const handleScan = useCallback(async () => {
    setScanBusy(true);
    try {
      const result = await runDiscoveryProbe("module-http", { hostIds: [], envTag: null });
      if (isDiscoverySkip(result)) {
        showToast(t("moduleHost.scanEmpty"));
        return;
      }
      const probed = result as DiscoveryCandidates;
      const rows = (probed.rows ?? []).filter((row) => row.candidate.pluginId === pluginId);
      if (!rows.length) {
        showToast(t("moduleHost.scanEmpty"));
        return;
      }
      setScanRows(rows);
      setScanOpen(true);
    } catch (err) {
      showToast(
        t("moduleHost.scanFailed", {
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      setScanBusy(false);
    }
  }, [pluginId, t]);

  const handleImport = useCallback(
    (selectedRows: DiscoveryPreviewRow[]) => {
      void (async () => {
        setScanBusy(true);
        try {
          const imported = await importModuleServiceRows(selectedRows);
          setScanOpen(false);
          showToast(
            t("moduleHost.scanDone", {
              added: String(imported.added),
              skipped: String(imported.skipped),
            }),
          );
        } finally {
          setScanBusy(false);
        }
      })();
    },
    [t],
  );

  const handleCloseTab = useCallback(
    (tabId: string) => {
      closeDockTabNow({ removeTabSync: () => closeTab(tabId) });
    },
    [closeTab],
  );

  const moduleDockTabs = useMemo(
    () =>
      moduleTabs
        .map((tab) => {
          const conn = serviceById.get(tab.connectionId);
          if (!conn) return null;
          return {
            id: tab.id,
            label: `${capabilityLabel(tab.capabilityId)}@${conn.name}`,
            panelType: "module-panel",
            closable: true,
            preview: tab.preview,
            tooltip: conn.name,
          };
        })
        .filter((tab): tab is NonNullable<typeof tab> => tab != null),
    [capabilityLabel, moduleTabs, serviceById],
  );

  const handleTabContextAction = useCallback(
    (action: TabContextMenuAction) => {
      if (!tabCtxMenu) return;
      const idx = moduleDockTabs.findIndex((tab) => tab.id === tabCtxMenu.tabId);
      if (action === "close") handleCloseTab(tabCtxMenu.tabId);
      else if (action === "closeLeft" && idx > 0) {
        for (const tab of moduleDockTabs.slice(0, idx)) handleCloseTab(tab.id);
      } else if (action === "closeRight" && idx >= 0 && idx < moduleDockTabs.length - 1) {
        for (const tab of moduleDockTabs.slice(idx + 1)) handleCloseTab(tab.id);
      } else if (action === "closeOthers" && idx >= 0) {
        for (const tab of moduleDockTabs.filter((row) => row.id !== tabCtxMenu.tabId)) {
          handleCloseTab(tab.id);
        }
      } else if (action === "closeAll") {
        for (const tab of moduleDockTabs) handleCloseTab(tab.id);
      }
      setTabCtxMenu(null);
    },
    [handleCloseTab, moduleDockTabs, tabCtxMenu],
  );

  const renderPanel = useCallback(
    (tabId: string) => {
      const tab = moduleTabs.find((item) => item.id === tabId);
      if (!tab) return <div className="server-panel-tab-pane" aria-hidden />;
      const connection = serviceById.get(tab.connectionId);
      if (!connection) return <div className="server-panel-tab-pane" aria-hidden />;
      return (
        <ModuleCapabilityWorkbench
          pluginId={pluginId}
          connection={connection}
          capabilityId={tab.capabilityId}
          namespaceId={connection.id === selected?.id ? namespaceId : connectionNamespaceId(connection)}
          namespaces={namespaces.items}
          capabilities={capabilities}
          capabilityLabel={capabilityLabel}
          onOpenCapability={(capabilityId) =>
            handleNavigate({ connectionId: connection.id, capabilityId }, "permanent")
          }
          onNamespacesReload={namespaces.reload}
        />
      );
    },
    [
      capabilities,
      capabilityLabel,
      handleNavigate,
      moduleTabs,
      namespaceId,
      namespaces.items,
      namespaces.reload,
      pluginId,
      selected?.id,
      serviceById,
    ],
  );

  const activeNavKey = activeTab
    ? makeModuleTreeKey({
        connectionId: activeTab.connectionId,
        capabilityId: activeTab.capabilityId,
      })
    : null;

  if (!activated || !pluginId) {
    return (
      <WorkspaceEmptyPage
        title={name}
        prompt={t("plugins.moduleShell.disabled", { name })}
      />
    );
  }

  return (
    <>
      <ModuleWorkspaceLayout
        className="module-host"
        leftColumnTitle={name}
        tagModuleKey={moduleKey}
        leftSidebar={
          <ModuleTreeSidebar
            moduleKey={moduleKey}
            services={services}
            capabilities={capabilities}
            capabilityLabel={capabilityLabel}
            activeNavKey={activeNavKey}
            activeConnectionId={selected?.id ?? null}
            hasNamespaceFilter={hasNamespaceCap}
            namespaceValue={namespaceSelectValue(namespaceId)}
            namespaceOptions={
              namespaces.items.length
                ? namespaces.items.map((row) => ({
                    value: namespaceSelectValue(row.namespaceId),
                    label: row.name || t("moduleHost.namespacePublic"),
                    subtitle: row.namespaceId || "public",
                  }))
                : [
                    {
                      value: namespaceSelectValue(""),
                      label: t("moduleHost.namespacePublic"),
                    },
                  ]
            }
            onNamespaceChange={(value) => persistNamespace(namespaceIdFromSelect(value))}
            scanBusy={scanBusy}
            onNavigate={handleNavigate}
            onCreate={() => {
              setEditConnection(undefined);
              setDialogOpen(true);
            }}
            onScan={() => void handleScan()}
            onEdit={(conn) => {
              setEditConnection(conn);
              setDialogOpen(true);
            }}
            onDelete={(conn) => {
              void appConfirm(t("moduleHost.deleteConnection", { name: conn.name })).then((ok) => {
                if (!ok) return;
                removeConnectionTabs(conn.id);
                void removeConn(conn.id);
              });
            }}
          />
        }
      >
        <ModuleSegmentDock
          className="module-host-dock"
          variant="workspace"
          dockScope={`module-panel:${moduleKey}`}
          moduleTitle={name}
          tabs={moduleDockTabs}
          activeTabId={activeTabId ?? ""}
          softRefreshKey={`${selected?.id ?? ""}:${namespaceId}`}
          onActiveTabChange={setActiveTabId}
          onCloseTab={handleCloseTab}
          onTabContextMenu={(event: ReactMouseEvent, tabId: string, index: number) => {
            event.preventDefault();
            setTabCtxMenu({ x: event.clientX, y: event.clientY, tabId, index });
          }}
          enabled={isActiveRoute}
          stickyVisit
          contentSuspended={!moduleLive}
          savedLayout={dockLayout}
          onSavedLayoutChange={setDockLayout}
          renderPanel={renderPanel}
          emptyContent={
            <WorkspaceEmptyPage
              title={name}
              prompt={t("plugins.moduleShell.hint", { name })}
              actions={
                <WorkbenchActionButton
                  onClick={() => {
                    setEditConnection(undefined);
                    setDialogOpen(true);
                  }}
                >
                  {t("moduleHost.newConnection")}
                </WorkbenchActionButton>
              }
            />
          }
        />
      </ModuleWorkspaceLayout>

      {isActiveRoute && tabCtxMenu ? (
        <ContextMenu
          items={buildTabCloseMenuItems(
            t,
            moduleDockTabs.length,
            moduleDockTabs.findIndex((tab) => tab.id === tabCtxMenu.tabId) >= 0
              ? moduleDockTabs.findIndex((tab) => tab.id === tabCtxMenu.tabId)
              : tabCtxMenu.index,
            handleTabContextAction,
          )}
          position={{ x: tabCtxMenu.x, y: tabCtxMenu.y }}
          onClose={() => setTabCtxMenu(null)}
        />
      ) : null}

      <ServiceConnectionDialog
        open={dialogOpen}
        pluginId={pluginId}
        connectionForm={manifest?.contributes.ui?.connectionForm}
        defaultPort={manifest?.contributes.module?.probe?.ports?.[0]}
        editConnection={editConnection}
        onClose={() => setDialogOpen(false)}
      />
      <DiscoveryImportDialog
        open={scanOpen}
        title={t("moduleHost.scanTitle")}
        hint={t("moduleHost.scanHint")}
        rows={scanRows}
        busy={scanBusy}
        onClose={() => setScanOpen(false)}
        onImport={handleImport}
      />
    </>
  );
}
