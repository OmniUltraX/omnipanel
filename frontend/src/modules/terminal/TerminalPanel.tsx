import { useEffect, useCallback, useState, useMemo } from "react";
import { useLocation } from "react-router-dom";
import { useTerminalStore } from "../../stores/terminalStore";
import { PaneRenderer } from "../../components/terminal/PaneRenderer";
import { TerminalSearch } from "../../components/terminal/TerminalSearch";
import { BlockContextMenu } from "../../components/terminal/BlockContextMenu";
import { DockWorkspace } from "../../components/dock";
import { ResourceRail } from "../../components/workspace/ResourceRail";
import { workspaceResources, getResourceById } from "../../lib/resourceRegistry";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useActionStore } from "../../stores/actionStore";
import { useTopbarTabs } from "../../hooks/useTopbarTabs";
import { useI18n } from "../../i18n";
import type { TerminalBlock } from "../../stores/blocksStore";
import type { SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";

let tabCounter = 0;

export function TerminalPanel() {
  const { t } = useI18n();
  const location = useLocation();
  const isActiveRoute = location.pathname === "/terminal";
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const layout = useTerminalStore((s) => s.layout);
  const addTab = useTerminalStore((s) => s.addTab);
  const removeTab = useTerminalStore((s) => s.removeTab);
  const setActiveTab = useTerminalStore((s) => s.setActiveTab);
  const activeResourceId = useWorkspaceStore((s) => s.activeResourceId);
  const activeResource = getResourceById(activeResourceId);
  const actions = useActionStore((s) => s.actions);
  const enqueueAction = useActionStore((s) => s.enqueueAction);

  const [searchVisible, setSearchVisible] = useState(false);
  const [searchTerminal, setSearchTerminal] = useState<Terminal | null>(null);
  const [searchAddon, setSearchAddon] = useState<SearchAddon | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    block: TerminalBlock;
    position: { x: number; y: number };
  } | null>(null);

  useEffect(() => {
    if (tabs.length === 0) {
      const id = `tab-${tabCounter++}`;
      addTab({ id, title: "local", type: "local" });
      setActiveTab(id);
    }
  }, [tabs.length, addTab, setActiveTab]);

  useEffect(() => {
    const handler = () => setSearchVisible((v) => !v);
    window.addEventListener("toggle-terminal-search", handler);
    return () => window.removeEventListener("toggle-terminal-search", handler);
  }, []);

  const handleAddTab = useCallback(() => {
    const id = `tab-${tabCounter++}`;
    addTab({ id, title: "local", type: "local" });
    setActiveTab(id);
  }, [addTab, setActiveTab]);

  const handleCloseTab = useCallback(
    (id: string) => {
      if (tabs.length <= 1) return;
      removeTab(id);
    },
    [tabs.length, removeTab]
  );

  const topbarTabs = useMemo(
    () =>
      tabs.map((tab) => ({
        id: tab.id,
        label: tab.title,
        active: tab.id === activeTabId,
        closable: tabs.length > 1,
        status: tab.status === "disconnected" ? "offline" as const : tab.status,
      })),
    [tabs, activeTabId]
  );

  useTopbarTabs(
    topbarTabs,
    {
      onSelect: setActiveTab,
      onClose: handleCloseTab,
      onAdd: handleAddTab,
    },
    { mode: "session", showAddTab: true, enabled: isActiveRoute }
  );

  const handleTerminalReady = useCallback(
    (_tabId: string, terminal: Terminal, sa: SearchAddon) => {
      setSearchTerminal(terminal);
      setSearchAddon(sa);
    },
    []
  );

  const handleCommand = useCallback(
    (command: string) => {
      enqueueAction({
        type: "terminal",
        title: t("terminal.actions.command"),
        description: command,
        command,
        resourceId: activeResource?.id ?? "local-terminal",
        source: "用户",
      });
    },
    [activeResource?.id, enqueueAction, t]
  );

  const handleBlockRightClick = useCallback(
    (block: TerminalBlock, position: { x: number; y: number }) => {
      setContextMenu({ block, position });
    },
    []
  );

  if (!layout || tabs.length === 0) return null;

  return (
    <DockWorkspace
      leftPreset="default"
      left={
        <ResourceRail
          title={t("terminal.sidebar.title")}
          resources={workspaceResources.filter((r) => ["terminal", "ssh", "server"].includes(r.type))}
        />
      }
      main={
        <div className="term-workspace">
          {searchVisible && searchTerminal && searchAddon && (
            <TerminalSearch
              terminal={searchTerminal}
              searchAddon={searchAddon}
              onClose={() => setSearchVisible(false)}
            />
          )}
          <div className="term-panes">
            <PaneRenderer
              layout={layout}
              activeTabId={activeTabId}
              suspended={!isActiveRoute}
              onTerminalReady={handleTerminalReady}
              onCommand={handleCommand}
              onBlockRightClick={handleBlockRightClick}
            />
          </div>
          {contextMenu && (
            <BlockContextMenu
              block={contextMenu.block}
              position={contextMenu.position}
              onClose={() => setContextMenu(null)}
            />
          )}
        </div>
      }
      right={
        <div className="context-panel">
          <div className="panel-title">{t("terminal.context.title")}</div>
          <div className="context-card">
            <span className="context-label">{t("terminal.context.resource")}</span>
            <strong>{activeResource?.name ?? "local"}</strong>
            <span>{activeResource?.subtitle ?? t("terminal.context.localSession")}</span>
          </div>
          <button
            className="btn btn-danger btn-sm"
            onClick={() =>
              enqueueAction({
                type: "terminal",
                title: t("terminal.actions.dangerDemo"),
                description: t("terminal.actions.dangerDemoDesc"),
                command: "sudo rm -rf /var/log/nginx/*.old",
                resourceId: activeResource?.id ?? "local-terminal",
                source: "用户",
              })
            }
          >
            {t("terminal.context.dangerConfirm")}
          </button>
        </div>
      }
      bottom={
        <div className="bottom-feed">
          <div className="panel-title">{t("terminal.feed.title")}</div>
          {actions.slice(0, 4).map((action) => (
            <div key={action.id} className="feed-row">
              <span>{action.title}</span>
              <span>{action.status}</span>
            </div>
          ))}
        </div>
      }
    />
  );
}
