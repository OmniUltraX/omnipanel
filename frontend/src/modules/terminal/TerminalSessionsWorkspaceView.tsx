import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { DockWorkspace } from "../../components/dock";
import { usePanelLayoutStore } from "../../stores/panelLayoutStore";
import { TerminalSessionSidebar } from "./TerminalSessionSidebar";
import { TerminalSessionsChromeProvider } from "./TerminalSessionsChromeContext";

const LAYOUT_PERSIST_KEY = "terminal-sessions";
const LEFT_MIN_PX = 180;
const LEFT_DEFAULT_PX = 220;
/** 低于此宽度视为侧栏已折叠 */
const LEFT_COLLAPSED_PX = 12;

export interface TerminalSessionsWorkspaceViewProps {
  onSelectSession: (sessionId: string) => void;
  onCreateSession: (resourceId: string, title: string) => void;
  onEndSession: (sessionId: string) => void;
  children: ReactNode;
}

/** 终端模块主布局：左侧会话树（独立于 tab）+ 右侧 tab 栏与终端视图。 */
export function TerminalSessionsWorkspaceView({
  onSelectSession,
  onCreateSession,
  onEndSession,
  children,
}: TerminalSessionsWorkspaceViewProps) {
  const savedSize = usePanelLayoutStore((s) => s.leftSizes[LAYOUT_PERSIST_KEY]);
  const setLeftSize = usePanelLayoutStore((s) => s.setLeftSize);
  const leftSizePx =
    typeof savedSize === "number" && savedSize >= LEFT_MIN_PX ? savedSize : LEFT_DEFAULT_PX;
  const pendingLeftSizeRef = useRef<number | null>(null);
  const leftPanelRef = useRef<PanelImperativeHandle | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const syncSidebarCollapsed = useCallback(() => {
    const panel = leftPanelRef.current;
    if (!panel) return;
    setSidebarCollapsed(panel.isCollapsed() || panel.getSize().inPixels < LEFT_COLLAPSED_PX);
  }, []);

  const handleLeftResize = useCallback((sizePx: number) => {
    pendingLeftSizeRef.current = sizePx;
    setSidebarCollapsed(sizePx < LEFT_COLLAPSED_PX);
  }, []);

  const handleLeftLayoutChanged = useCallback(() => {
    const size = pendingLeftSizeRef.current ?? leftPanelRef.current?.getSize().inPixels ?? leftSizePx;
    pendingLeftSizeRef.current = null;
    if (size < LEFT_MIN_PX) {
      syncSidebarCollapsed();
      return;
    }
    setLeftSize(LAYOUT_PERSIST_KEY, size);
    syncSidebarCollapsed();
  }, [setLeftSize, syncSidebarCollapsed]);

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

  return (
    <TerminalSessionsChromeProvider value={{ sidebarCollapsed }}>
      <DockWorkspace
        className={`term-sessions-workspace${sidebarCollapsed ? " term-sessions-workspace--sidebar-collapsed" : " term-sessions-workspace--sidebar-open"}`}
        leftPreset="settings"
        leftSizePx={leftSizePx}
        leftMinPx={LEFT_MIN_PX}
        leftMaxPx={320}
        leftPanelRef={leftPanelRef}
        leftHandleClassName={
          sidebarCollapsed
            ? "term-sessions-sidebar-handle term-sessions-sidebar-handle--collapsed"
            : "term-sessions-sidebar-handle term-sessions-sidebar-handle--open"
        }
        onLeftResize={handleLeftResize}
        onLeftLayoutChanged={handleLeftLayoutChanged}
        left={sidebar}
        main={children}
      />
    </TerminalSessionsChromeProvider>
  );
}
