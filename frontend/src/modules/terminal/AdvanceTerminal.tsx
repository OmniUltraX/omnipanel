import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { LocalFilePanel } from "@/components/files";
import { SftpPanel } from "@/components/sftp";
import { TunnelPanel } from "@/components/tunnel";
import { WorkspaceComponent } from "@/components/workspace/WorkspaceComponent";
import { useI18n } from "@/i18n";
import { normalizeTerminalCwdForSftp } from "@/modules/server/ssh/utils/parseCommandPaths";
import { useSshDetailNavigationStore } from "@/stores/sshDetailNavigationStore";
import { useBottomPanelStore } from "@/stores/bottomPanelStore";
import { useTerminalStore } from "@/stores/terminalStore";
import { TerminalTabPaneView } from "./TerminalPaneView";
import { AdvanceTerminalMonitorStack } from "./AdvanceTerminalMonitorStack";
import { AdvanceTerminalSideEntry } from "./AdvanceTerminalSideEntry";
import { useTerminalTabDockPane } from "./useTerminalTabDockPane";

type LocalSidePanelId = "files" | "monitor";
type RemoteSidePanelId = "sftp" | "tunnel" | "processes";
type SidePanelId = LocalSidePanelId | RemoteSidePanelId;

type SidePanelWorkspaceSpec = {
  componentType: string;
  label: string;
  props?: Record<string, unknown>;
  snapshotId?: string;
};

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

export function AdvanceTerminal({
  tabId,
  isActive: isActiveProp,
  onActivate,
  sideDockScope,
}: AdvanceTerminalProps) {
  const { t } = useI18n();
  // dockview renderPanel 仅在 panel 创建时调用一次，isActive prop 会过时。
  // 模块主 dock：订阅 store 拿实时激活态；镜像/SubWindow（有 sideDockScope）仍用调用方 prop。
  const storeIsActive = useTerminalStore((s) => s.activeTabId === tabId);
  const taskbarSubWindowTabId = useBottomPanelStore((s) => s.taskbarSubWindowTabId);
  const isActive = sideDockScope
    ? isActiveProp
    : storeIsActive && tabId !== taskbarSubWindowTabId;
  const { paneProps, resource, tab } = useTerminalTabDockPane(tabId, isActive, onActivate);

  const isRemoteSsh = useMemo(
    () => tab?.session.type === "remote" && resource?.type === "ssh",
    [tab?.session.type, resource?.type],
  );
  const isLocal = tab?.session.type === "local";

  const sideTabs = useMemo((): SideTabButton[] => {
    if (isLocal) {
      return [
        { id: "monitor", label: t("terminal.sideTabs.monitor") },
        { id: "files", label: t("terminal.sideTabs.files") },
      ];
    }
    return [
      { id: "processes", label: t("ssh.detailTabs.processes") },
      { id: "sftp", label: t("ssh.detailTabs.sftp") },
      { id: "tunnel", label: t("ssh.detailTabs.tunnels") },
    ];
  }, [isLocal, t]);

  const [activeSideTab, setActiveSideTab] = useState<SidePanelId>(() =>
    isLocal ? "monitor" : "processes",
  );
  const activeSideTabRef = useRef(activeSideTab);
  activeSideTabRef.current = activeSideTab;

  const [sideCollapsed, setSideCollapsed] = useState(true);
  // 首次展开后保持侧栏挂载：切终端 tab 时只隐藏不卸载，避免监控/SFTP 重新加载
  const [sideContentMounted, setSideContentMounted] = useState(false);
  const [sideWidth, setSideWidth] = useState(SIDE_DEFAULT_EXPANDED_PX);
  const sideWidthRef = useRef(SIDE_DEFAULT_EXPANDED_PX);
  sideWidthRef.current = sideWidth;
  const [sessionHeaderHost, setSessionHeaderHost] = useState<HTMLDivElement | null>(null);

  // 侧栏显隐只跟用户收起偏好，绝不能绑 isActive。
  // DockableWorkspace 切 tab 时 overlay 立刻切换（终端秒出），但 isActive 经 startTransition 延后；
  // 若按 !isActive 把宽度收成 0，侧栏会等 React 更新才展开，看起来像「又加载了一下」。
  // 非激活 panel 已由 dockview visibility:hidden 盖住，侧栏保持原宽即可随 overlay 一起出现。
  const sideVisuallyCollapsed = sideCollapsed;
  const sideEntryExpanded = !sideCollapsed && isActive;

  const openSidePanel = useCallback((targetTab: SidePanelId) => {
    activeSideTabRef.current = targetTab;
    setActiveSideTab(targetTab);
    setSideContentMounted(true);
    setSideCollapsed(false);
  }, []);

  /** 顶部入口：收起→展开；展开且点当前→收起；展开且点其它→切换 */
  const handleSideEntrySelect = useCallback(
    (id: string) => {
      const target = id as SidePanelId;
      if (!sideCollapsed && target === activeSideTabRef.current) {
        setSideCollapsed(true);
        return;
      }
      openSidePanel(target);
    },
    [openSidePanel, sideCollapsed],
  );

  useEffect(() => {
    if (!sideTabs.some((item) => item.id === activeSideTab)) {
      const fallback = (sideTabs[0]?.id ?? "monitor") as SidePanelId;
      activeSideTabRef.current = fallback;
      setActiveSideTab(fallback);
    }
  }, [activeSideTab, sideTabs]);

  const openTunnelTab = useCallback(() => {
    openSidePanel("tunnel");
  }, [openSidePanel]);

  const requestSftp = useSshDetailNavigationStore((s) => s.requestSftp);
  const pendingSideFocus = useSshDetailNavigationStore((s) => s.pendingSideFocus);
  const consumeSideFocus = useSshDetailNavigationStore((s) => s.consumeSideFocus);
  const lastSyncedSftpCwdRef = useRef<string | null>(null);
  const handledSideFocusNonceRef = useRef<number | null>(null);

  useEffect(() => {
    lastSyncedSftpCwdRef.current = null;
  }, [resource?.id, tabId]);

  useEffect(() => {
    if (!isRemoteSsh || !resource?.id || tab?.status !== "connected") return;
    const sftpPath = normalizeTerminalCwdForSftp(tab.session.cwd);
    if (!sftpPath) return;
    if (lastSyncedSftpCwdRef.current === sftpPath) return;
    lastSyncedSftpCwdRef.current = sftpPath;
    requestSftp(resource.id, sftpPath);
  }, [isRemoteSsh, resource?.id, tab?.status, tab?.session.cwd, requestSftp]);

  // 从 ls block 右键「在 SFTP / 文件面板中显示」展开侧栏并聚焦
  useEffect(() => {
    if (!pendingSideFocus) return;
    if (handledSideFocusNonceRef.current === pendingSideFocus.nonce) return;
    if (!isActive) return;

    if (pendingSideFocus.panel === "sftp") {
      if (!isRemoteSsh || !resource?.id || pendingSideFocus.resourceId !== resource.id) return;
      const consumed = consumeSideFocus(resource.id);
      if (!consumed) return;
      handledSideFocusNonceRef.current = consumed.nonce;
      lastSyncedSftpCwdRef.current = consumed.path;
      openSidePanel("sftp");
      return;
    }

    if (pendingSideFocus.panel === "files") {
      if (!isLocal) return;
      const consumed = consumeSideFocus(null);
      if (!consumed || consumed.panel !== "files") return;
      handledSideFocusNonceRef.current = consumed.nonce;
      openSidePanel("files");
    }
  }, [
    pendingSideFocus,
    isActive,
    isRemoteSsh,
    isLocal,
    resource?.id,
    consumeSideFocus,
    openSidePanel,
  ]);

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
    [resource?.id, sideTabs, t],
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
    [isLocal, openTunnelTab, resource, wrapSidePanel],
  );

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

  const sideEntry = (
    <AdvanceTerminalSideEntry
      tabs={sideTabs}
      activeId={activeSideTab}
      expanded={sideEntryExpanded}
      onSelect={handleSideEntrySelect}
    />
  );

  if (!isRemoteSsh && !isLocal) {
    return (
      <div className="advance-terminal advance-terminal--local">
        <TerminalTabPaneView {...paneProps} />
      </div>
    );
  }

  return (
    <div className="advance-terminal">
      <div
        ref={setSessionHeaderHost}
        className="advance-terminal-session-chrome"
      />
      <div className="advance-terminal-body">
        <div className="advance-terminal-main">
          <TerminalTabPaneView
            {...paneProps}
            headerAccessory={sideEntry}
            headerPortalHost={sessionHeaderHost}
          />
        </div>
        {!sideVisuallyCollapsed && (
          <div
            ref={sideResizerRef}
            className="advance-terminal-side-resizer"
            onPointerDown={onResizerPointerDown}
            onPointerMove={onResizerPointerMove}
            onPointerUp={onResizerPointerUp}
            onPointerCancel={onResizerPointerUp}
          />
        )}
        {sideContentMounted ? (
          <div
            className="advance-terminal-side"
            style={
              sideVisuallyCollapsed
                ? {
                    width: 0,
                    border: "none",
                    overflow: "hidden",
                    pointerEvents: "none",
                    // 不用 display:none，避免再次展开时图表/表格从 0 尺寸重算
                    visibility: "hidden",
                  }
                : { width: `${sideWidth}px` }
            }
            aria-hidden={sideVisuallyCollapsed}
          >
            <div className="advance-terminal-side-content">
              {renderSidePanel(activeSideTab)}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
