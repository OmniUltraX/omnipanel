import { useMemo, type ReactNode } from "react";
import { ModuleWorkspaceLayout } from "../../components/workspace";
import { TerminalSessionSidebar } from "./TerminalSessionSidebar";
import { TerminalSessionsChromeProvider } from "./TerminalSessionsChromeContext";
import { usePanelLayoutStore } from "../../stores/panelLayoutStore";
import { useI18n } from "../../i18n";
import type { WorkspaceInfo } from "../../stores/workspaceStore";

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

  const rootClass = [
    "term-sessions-workspace",
    sidebarCollapsed
      ? "term-sessions-workspace--sidebar-collapsed"
      : "term-sessions-workspace--sidebar-open",
  ]
    .filter(Boolean)
    .join(" ");

  const layout = (
    <ModuleWorkspaceLayout
      className={rootClass}
      leftColumnTitle={t("routes.terminal")}
      leftSidebar={sessionSidebar}
      tagModuleKey="terminal"
    >
      {children}
    </ModuleWorkspaceLayout>
  );

  return (
    <TerminalSessionsChromeProvider value={{ sidebarCollapsed }}>
      {layout}
    </TerminalSessionsChromeProvider>
  );
}
