import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DockableWorkspace,
  type DockableTab,
  type SerializedDockview,
} from "@/components/dock";
import { LocalFilePanel } from "@/components/files";
import { SftpPanel } from "@/components/sftp";
import { TunnelPanel } from "@/components/tunnel";
import { WorkspaceComponent } from "@/components/workspace/WorkspaceComponent";
import { useI18n } from "@/i18n";
import { normalizeTerminalCwdForSftp } from "@/modules/server/ssh/utils/parseCommandPaths";
import { useSshDetailNavigationStore } from "@/stores/sshDetailNavigationStore";
import { TerminalTabPaneView } from "./TerminalPaneView";
import { AdvanceTerminalMonitorStack } from "./AdvanceTerminalMonitorStack";
import { TerminalHistoryPanel } from "./TerminalHistoryPanel";
import { useTerminalTabDockPane } from "./useTerminalTabDockPane";

type LocalSidePanelId = "files" | "monitor" | "history";
type RemoteSidePanelId = "sftp" | "tunnel" | "processes" | "history";
type SidePanelId = LocalSidePanelId | RemoteSidePanelId;

type SidePanelWorkspaceSpec = {
  componentType: string;
  label: string;
  props?: Record<string, unknown>;
  snapshotId?: string;
};

const SIDE_TAB_RAIL_PX = 38;
const SIDE_DEFAULT_EXPANDED_PX = 380;
const SIDE_MIN_EXPANDED_PX = 240;
const SIDE_MAX_EXPANDED_PX = 600;

export type AdvanceTerminalProps = {
  tabId: string;
  isActive: boolean;
  onActivate?: () => void;
  sideDockScope?: string;
};

interface SideTabButton {
  id: SidePanelId;
  label: string;
}

export function AdvanceTerminal({ tabId, isActive, onActivate, sideDockScope }: AdvanceTerminalProps) {
  const { t } = useI18n();
  const { paneProps, resource, tab } = useTerminalTabDockPane(tabId, isActive, onActivate);

  const isRemoteSsh = useMemo(
    () => tab?.session.type === "remote" && resource?.type === "ssh",
    [tab?.session.type, resource?.type],
  );
  const isLocal = tab?.session.type === "local";

  const sideTabs = useMemo((): SideTabButton[] => {
    const historyTab: SideTabButton = {
      id: "history",
      label: t("terminal.sideTabs.history"),
    };
    if (isLocal) {
      return [
        { id: "monitor", label: t("terminal.sideTabs.monitor") },
        { id: "files", label: t("terminal.sideTabs.files") },
        historyTab,
      ];
    }
    return [
      { id: "processes", label: t("ssh.detailTabs.processes") },
      { id: "sftp", label: t("ssh.detailTabs.sftp") },
      { id: "tunnel", label: t("ssh.detailTabs.tunnels") },
      historyTab,
    ];
  }, [isLocal, t]);

  const sideDockTabs = useMemo((): DockableTab[] => sideTabs.map((s) => ({
    id: s.id,
    label: s.label,
    panelType: "terminal-side",
    closable: false,
  })), [sideTabs]);

  const [activeSideTab, setActiveSideTab] = useState<SidePanelId>(() =>
    isLocal ? "monitor" : "processes",
  );
  const activeSideTabRef = useRef(activeSideTab);
  activeSideTabRef.current = activeSideTab;

  // 收起 / 展开状态
  const [sideCollapsed, setSideCollapsed] = useState(true);
  // 首次展开后保持 DockableWorkspace 挂载（避免条件渲染销毁/重建 dockview 实例）
  const [sideDockMounted, setSideDockMounted] = useState(false);

  // 侧栏宽度（像素），用于展开态拖拽
  const [sideWidth, setSideWidth] = useState(SIDE_DEFAULT_EXPANDED_PX);
  const sideWidthRef = useRef(SIDE_DEFAULT_EXPANDED_PX);
  sideWidthRef.current = sideWidth;

  const sideLayoutRef = useRef<SerializedDockview | null>(null);
  const handleSideLayoutChange = useCallback((layout: SerializedDockview | null) => {
    sideLayoutRef.current = layout;
  }, []);

  // dockview onActiveTabChange：用户点击不同 tab 时触发。
  // 程序化 setActive 期间的伪事件已由 DockableWorkspace 的 runProgrammaticActive
  // 在 onDidActivePanelChange 层面过滤，这里无需再额外处理初始化期事件。
  const handleSideTabChange = useCallback((id: string) => {
    const next = id as SidePanelId;
    console.log(`[handleSideTabChange] id=${id} current=${activeSideTabRef.current}`);
    if (next === activeSideTabRef.current) return;
    activeSideTabRef.current = next;
    setActiveSideTab(next);
  }, []);

  // 收起态自绘按钮点击：展开并激活目标 tab
  const handleCollapsedTabClick = useCallback((targetTab: SidePanelId) => {
    activeSideTabRef.current = targetTab;
    setActiveSideTab(targetTab);
    setSideDockMounted(true);
    setSideCollapsed(false);
  }, []);

  // 展开态 dockview 容器 ref
  const sideDockWrapRef = useRef<HTMLDivElement | null>(null);

  // DockableWorkspace.onTabClick：仅当 wasActive=true（点击当前已激活 tab）时收起。
  // wasActive 的判断由 DockableWorkspace 在 pointerdown capture 阶段通过
  // dv-active-tab class 检测，不受 dockview pointerdown 同步切换激活 tab 的影响。
  const handleSideTabClick = useCallback(
    (_tabId: string, wasActive: boolean) => {
      if (wasActive) {
        setSideCollapsed(true);
      }
    },
    [],
  );

  useEffect(() => {
    if (!sideTabs.some((item) => item.id === activeSideTab)) {
      const fallback = (sideTabs[0]?.id ?? "history") as SidePanelId;
      activeSideTabRef.current = fallback;
      setActiveSideTab(fallback);
    }
  }, [activeSideTab, sideTabs]);

  const openTunnelTab = useCallback(() => {
    activeSideTabRef.current = "tunnel";
    setActiveSideTab("tunnel");
    setSideDockMounted(true);
    setSideCollapsed(false);
  }, []);

  const requestSftp = useSshDetailNavigationStore((s) => s.requestSftp);
  const lastSyncedSftpCwdRef = useRef<string | null>(null);

  useEffect(() => {
    lastSyncedSftpCwdRef.current = null;
  }, [resource?.id, tabId]);

  useEffect(() => {
    if (!isRemoteSsh || !resource?.id || tab?.status !== "connected") return;
    const sftpPath = normalizeTerminalCwdForSftp(tab.session.cwd);
    if (!sftpPath) return;
    if (lastSyncedSftpCwdRef.current === sftpPath) return;
    console.log(`[sftp-sync] cwd=${tab.session.cwd} sftpPath=${sftpPath} lastSynced=${lastSyncedSftpCwdRef.current} resource.id=${resource.id} tabId=${tabId}`);
    lastSyncedSftpCwdRef.current = sftpPath;
    requestSftp(resource.id, sftpPath);
  }, [isRemoteSsh, resource?.id, tab?.status, tab?.session.cwd, requestSftp]);

  const resolveSidePanelSpec = useCallback(
    (sideTabId: string): SidePanelWorkspaceSpec | null => {
      const sideTab = sideTabs.find((item) => item.id === sideTabId);
      if (sideTabId === "files") {
        return {
          componentType: "files.local-panel",
          label: sideTab?.label ?? t("terminal.sideTabs.files"),
          props: {},
          snapshotId: "files.local-panel",
        };
      }
      if (sideTabId === "monitor") {
        return {
          componentType: "terminal.side.monitor-local",
          label: sideTab?.label ?? t("terminal.sideTabs.monitor"),
          snapshotId: "terminal.side.monitor-local",
        };
      }
      if (sideTabId === "history") {
        return {
          componentType: "terminal.side.history",
          label: sideTab?.label ?? t("terminal.sideTabs.history"),
          snapshotId: `terminal.side.history:${tabId}`,
        };
      }
      if (!resource?.id) return null;
      if (sideTabId === "sftp") {
        return {
          componentType: "ssh.detail.sftp",
          label: sideTab?.label ?? t("ssh.detailTabs.sftp"),
          props: { resourceId: resource.id },
          snapshotId: `ssh.detail.sftp:${resource.id}`,
        };
      }
      if (sideTabId === "tunnel") {
        return {
          componentType: "ssh.detail.tunnel",
          label: sideTab?.label ?? t("ssh.detailTabs.tunnels"),
          props: { resourceId: resource.id },
          snapshotId: `ssh.detail.tunnel:${resource.id}`,
        };
      }
      if (sideTabId === "processes") {
        return {
          componentType: "terminal.side.monitor-remote",
          label: sideTab?.label ?? t("ssh.detailTabs.processes"),
          props: { resourceId: resource.id },
          snapshotId: `terminal.side.monitor-remote:${resource.id}`,
        };
      }
      return null;
    },
    [resource?.id, sideTabs, t, tabId],
  );

  const wrapSidePanel = useCallback(
    (sideTabId: string, node: ReactNode) => {
      const spec = resolveSidePanelSpec(sideTabId);
      if (!spec) return node;
      return (
        <WorkspaceComponent
          componentType={spec.componentType}
          label={spec.label}
          props={spec.props}
          snapshotId={spec.snapshotId}
          className="advance-terminal-side-panel-root"
        >
          {node}
        </WorkspaceComponent>
      );
    },
    [resolveSidePanelSpec],
  );

  const renderSidePanel = useCallback(
    (panelId: string) => {
      console.log(`[renderSidePanel] panelId=${panelId} activeSideTab=${activeSideTabRef.current}`);
      if (panelId === "history") {
        return wrapSidePanel(
          "history",
          <TerminalHistoryPanel
            sessionId={tabId}
            sessionTitle={tab?.title}
            onRunCommand={paneProps?.onSendCommand}
          />,
        );
      }
      if (isLocal) {
        if (panelId === "files") {
          return wrapSidePanel("files", <LocalFilePanel />);
        }
        if (panelId === "monitor") {
          return wrapSidePanel("monitor", <AdvanceTerminalMonitorStack mode="local" />);
        }
        return null;
      }
      if (!resource) return null;
      if (panelId === "sftp") {
        return wrapSidePanel("sftp", <SftpPanel resourceId={resource.id} />);
      }
      if (panelId === "tunnel") {
        return wrapSidePanel("tunnel", <TunnelPanel activeResource={resource} />);
      }
      if (panelId === "processes") {
        return wrapSidePanel(
          "processes",
          <AdvanceTerminalMonitorStack
            mode="remote"
            resourceId={resource.id}
            enableTunnels
            onOpenTunnelTab={openTunnelTab}
          />,
        );
      }
      return null;
    },
    [isLocal, openTunnelTab, paneProps?.onSendCommand, resource, tab?.title, tabId, wrapSidePanel],
  );

  // ===== 拖拽分隔条：调整侧栏宽度 =====
  const sideResizerRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const onResizerPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragStateRef.current = {
      startX: event.clientX,
      startWidth: sideWidthRef.current,
    };
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
  }, []);

  const onResizerPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const state = dragStateRef.current;
    if (!state) return;
    // 侧栏在右侧，鼠标向左拖动应增加宽度
    const delta = state.startX - event.clientX;
    const next = Math.max(
      SIDE_MIN_EXPANDED_PX,
      Math.min(SIDE_MAX_EXPANDED_PX, state.startWidth + delta),
    );
    sideWidthRef.current = next;
    setSideWidth(next);
  }, []);

  const onResizerPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    dragStateRef.current = null;
    try {
      (event.target as HTMLElement).releasePointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
  }, []);

  if (!paneProps) return null;

  const terminalPane = <TerminalTabPaneView {...paneProps} />;

  if (!isRemoteSsh && !isLocal) {
    return (
      <div className="advance-terminal advance-terminal--local">
        {terminalPane}
      </div>
    );
  }

  return (
    <div className="advance-terminal">
      <div className="advance-terminal-main">
        {terminalPane}
      </div>
      {!sideCollapsed && (
        <div
          ref={sideResizerRef}
          className="advance-terminal-side-resizer"
          onPointerDown={onResizerPointerDown}
          onPointerMove={onResizerPointerMove}
          onPointerUp={onResizerPointerUp}
          onPointerCancel={onResizerPointerUp}
        />
      )}
      <div
        className={`advance-terminal-side${sideCollapsed ? " advance-terminal-side--collapsed" : ""}`}
        style={sideCollapsed ? undefined : { width: `${sideWidth}px` }}
      >
        {sideCollapsed && (
          // 收起态：自绘竖排 tab 按钮（覆盖在隐藏的 dockview 之上）
          <div className="advance-terminal-side-rail">
            {sideTabs.map((sideTab) => (
              <button
                key={sideTab.id}
                type="button"
                className="advance-terminal-side-rail-btn"
                onClick={() => handleCollapsedTabClick(sideTab.id)}
                title={sideTab.label}
                aria-label={sideTab.label}
              >
                <span className="advance-terminal-side-rail-label">{sideTab.label}</span>
              </button>
            ))}
          </div>
        )}
        {/* 展开态：dockview 实例。首次展开后一直保持挂载，避免销毁/重建导致 tab 切换异常 */}
        {sideDockMounted && (
          <div
            ref={sideDockWrapRef}
            className="advance-terminal-side-dock-wrap"
            style={sideCollapsed ? { display: "none" } : undefined}
          >
            <DockableWorkspace
              key={`side-expanded-${tabId}-${isLocal ? "local" : "remote"}`}
              className="advance-terminal-side-dock"
              dockScope={sideDockScope ?? `terminal-side-${tabId}`}
              tabs={sideDockTabs}
              activeTabId={activeSideTab}
              onActiveTabChange={handleSideTabChange}
              onTabClick={handleSideTabClick}
              onCloseTab={() => {}}
              savedLayout={sideLayoutRef.current}
              onSavedLayoutChange={handleSideLayoutChange}
              renderPanel={renderSidePanel}
              enableTabGroups={false}
              defaultHeaderPosition="right"
              disableTabsOverflowList
              scrollbars="native"
            />
          </div>
        )}
      </div>
    </div>
  );
}
