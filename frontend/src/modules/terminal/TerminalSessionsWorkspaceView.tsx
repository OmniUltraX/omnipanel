import { useCallback, useMemo, startTransition, type ReactNode } from "react";
import { ModuleModeIconRail, ModuleWorkspaceLayout } from "../../components/workspace";
import { TerminalSessionSidebar } from "./TerminalSessionSidebar";
import { TerminalSessionsChromeProvider } from "./TerminalSessionsChromeContext";
import { SshHostSidebar } from "../server/ssh/SshHostSidebar";
import { SshSidebarLinkageProvider } from "../server/ssh/SshSidebarLinkageContext";
import { useSshHostWorkspace } from "../server/ssh/hooks/useSshHostWorkspace";
import { SSH_PATH } from "../server/ssh/constants";
import { useWorkspaceStore, type WorkspaceInfo } from "../../stores/workspaceStore";
import { useSshHostResources } from "../../stores/connectionStore";
import { useSshSelectionStore } from "../server/ssh/stores/sshSelectionStore";
import { useTerminalLeftPanelStore } from "./terminalLeftPanelStore";
import { usePanelLayoutStore } from "../../stores/panelLayoutStore";
import { useI18n } from "../../i18n";

function TerminalPanelIcon({ active }: { active?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      width="14"
      height="14"
      aria-hidden
      style={{ opacity: active ? 1 : 0.72 }}
    >
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function SshPanelIcon({ active }: { active?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      width="14"
      height="14"
      aria-hidden
      style={{ opacity: active ? 1 : 0.72 }}
    >
      <rect x="2" y="2" width="20" height="8" rx="2" />
      <rect x="2" y="14" width="20" height="8" rx="2" />
      <circle cx="6" cy="6" r="1" fill="currentColor" />
      <circle cx="6" cy="18" r="1" fill="currentColor" />
    </svg>
  );
}

export interface TerminalSessionsWorkspaceViewProps {
  onSelectSession: (sessionId: string) => void;
  onCreateSession: (resourceId: string, title: string) => void;
  onEndSession: (sessionId: string) => void;
  /** 会话右键「在工作区打开」：将指定会话移到目标工作区。 */
  onOpenSessionInWorkspace?: (sessionId: string, workspaceId: string) => void;
  /** 当前工作区 id。 */
  currentWorkspaceId?: string;
  /** 可用工作区列表。 */
  workspaces?: WorkspaceInfo[];
  /** 连接右键「结束所有会话」。 */
  onEndAllSessionsInConnection?: (resourceId: string) => void;
  /** 连接右键「重命名连接」。 */
  onRenameConnection?: (resourceId: string, currentName: string) => void;
  children: ReactNode;
}

/** 终端模块主布局：左侧会话树 + 右侧 session Tab 与终端视图。 */
export function TerminalSessionsWorkspaceView({
  onSelectSession,
  onCreateSession,
  onEndSession,
  onOpenSessionInWorkspace,
  currentWorkspaceId,
  workspaces,
  onEndAllSessionsInConnection,
  onRenameConnection,
  children,
}: TerminalSessionsWorkspaceViewProps) {
  const { t } = useI18n();
  const sidebarCollapsed = usePanelLayoutStore((s) => s.moduleLeftSidebarCollapsed);
  const leftPanelMode = useTerminalLeftPanelStore((s) => s.mode);
  const setLeftPanelMode = useTerminalLeftPanelStore((s) => s.setMode);
  const sshResources = useSshHostResources();
  const selectResource = useWorkspaceStore((s) => s.selectResource);
  const { activeHostId, handleSelectHost: setActiveHost } = useSshHostWorkspace(sshResources);
  const handleSelectHost = useCallback(
    (hostId: string, mode?: Parameters<typeof setActiveHost>[1]) => {
      setActiveHost(hostId, mode);
      if (sshResources.some((item) => item.id === hostId)) {
        selectResource(hostId, SSH_PATH);
      }
    },
    [selectResource, setActiveHost, sshResources],
  );
  const selectionMode = useSshSelectionStore((s) => s.selectionMode);
  const selectedIds = useSshSelectionStore((s) => s.selectedIds);
  const isSshMode = leftPanelMode === "ssh";

  const sessionSidebar = useMemo(
    () => (
      <TerminalSessionSidebar
        onSelectSession={onSelectSession}
        onCreateSession={onCreateSession}
        onEndSession={onEndSession}
        onOpenSessionInWorkspace={onOpenSessionInWorkspace}
        currentWorkspaceId={currentWorkspaceId}
        workspaces={workspaces}
        onEndAllSessionsInConnection={onEndAllSessionsInConnection}
        onRenameConnection={onRenameConnection}
      />
    ),
    [
      onCreateSession,
      onEndSession,
      onEndAllSessionsInConnection,
      onOpenSessionInWorkspace,
      onRenameConnection,
      onSelectSession,
      currentWorkspaceId,
      workspaces,
    ],
  );

  const sshSidebar = useMemo(
    () => (
      <SshHostSidebar
        resources={sshResources}
        onSelectHost={handleSelectHost}
        selectionMode={selectionMode}
        selectedIds={selectedIds}
        tagModuleKey="terminal"
      />
    ),
    [handleSelectHost, selectedIds, selectionMode, sshResources],
  );

  const leftIconRail = useMemo(
    () => (
      <ModuleModeIconRail
        items={[
          {
            id: "sessions",
            label: t("terminal.leftPanel.sessions"),
            iconNode: <TerminalPanelIcon active={!isSshMode} />,
          },
          {
            id: "ssh",
            label: t("terminal.leftPanel.ssh"),
            iconNode: <SshPanelIcon active={isSshMode} />,
          },
        ]}
        activeId={leftPanelMode}
        onChange={(id) => {
          startTransition(() => {
            setLeftPanelMode(id as "sessions" | "ssh");
          });
        }}
      />
    ),
    [isSshMode, leftPanelMode, setLeftPanelMode, t],
  );

  const sidebarLinkageValue = useMemo(
    () => ({ activeHostId: isSshMode ? activeHostId : null }),
    [activeHostId, isSshMode],
  );

  const rootClass = [
    "term-sessions-workspace",
    sidebarCollapsed
      ? "term-sessions-workspace--sidebar-collapsed"
      : "term-sessions-workspace--sidebar-open",
    isSshMode ? "term-sessions-workspace--ssh-mode" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const dualSidebar = useMemo(
    () => (
      <div className="term-sidebar-dual">
        <div
          className={`term-sidebar-dual__pane${!isSshMode ? " term-sidebar-dual__pane--active" : ""}`}
          aria-hidden={isSshMode}
        >
          {sessionSidebar}
        </div>
        <div
          className={`term-sidebar-dual__pane${isSshMode ? " term-sidebar-dual__pane--active" : ""}`}
          aria-hidden={!isSshMode}
        >
          {sshSidebar}
        </div>
      </div>
    ),
    [isSshMode, sessionSidebar, sshSidebar],
  );

  const layout = (
    <ModuleWorkspaceLayout
      className={rootClass}
      leftColumnTitle={isSshMode ? t("routes.ssh") : t("routes.terminal")}
      leftIconRail={leftIconRail}
      leftSidebar={dualSidebar}
      tagModuleKey="terminal"
    >
      {children}
    </ModuleWorkspaceLayout>
  );

  return (
    <TerminalSessionsChromeProvider value={{ sidebarCollapsed, leftPanelMode }}>
      <SshSidebarLinkageProvider value={sidebarLinkageValue}>{layout}</SshSidebarLinkageProvider>
    </TerminalSessionsChromeProvider>
  );
}
