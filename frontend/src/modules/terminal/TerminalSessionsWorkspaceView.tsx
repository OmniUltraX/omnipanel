import { useCallback, useMemo, useState, type ReactNode } from "react";
import { ModuleWorkspaceLayout } from "../../components/workspace";
import { TerminalSessionSidebar } from "./TerminalSessionSidebar";
import { TerminalSessionsChromeProvider } from "./TerminalSessionsChromeContext";
import { useI18n } from "../../i18n";

export interface TerminalSessionsWorkspaceViewProps {
  onSelectSession: (sessionId: string) => void;
  onCreateSession: (resourceId: string, title: string) => void;
  onEndSession: (sessionId: string) => void;
  children: ReactNode;
}

/** 终端模块主布局：左侧会话树 + 右侧 session Tab 与终端视图。 */
export function TerminalSessionsWorkspaceView({
  onSelectSession,
  onCreateSession,
  onEndSession,
  children,
}: TerminalSessionsWorkspaceViewProps) {
  const { t } = useI18n();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const handleSidebarCollapsedChange = useCallback((collapsed: boolean) => {
    setSidebarCollapsed(collapsed);
  }, []);

  const sidebar = useMemo(
    () => (
      <TerminalSessionSidebar
        onSelectSession={onSelectSession}
        onCreateSession={onCreateSession}
        onEndSession={onEndSession}
      />
    ),
    [onCreateSession, onEndSession, onSelectSession],
  );

  const rootClass = [
    "term-sessions-workspace",
    sidebarCollapsed
      ? "term-sessions-workspace--sidebar-collapsed"
      : "term-sessions-workspace--sidebar-open",
  ].join(" ");

  return (
    <TerminalSessionsChromeProvider value={{ sidebarCollapsed }}>
      <ModuleWorkspaceLayout
        className={rootClass}
        leftColumnTitle={t("routes.terminal")}
        leftPreset="settings"
        onSidebarCollapsedChange={handleSidebarCollapsedChange}
        leftSidebar={sidebar}
      >
        {children}
      </ModuleWorkspaceLayout>
    </TerminalSessionsChromeProvider>
  );
}
