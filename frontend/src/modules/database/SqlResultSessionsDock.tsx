import { memo, useCallback, useMemo, useRef } from "react";
import type { SerializedDockview } from "dockview-core";
import { DockableWorkspace, type DockableTab } from "../../components/dock";
import {
  makeSqlResultSessionLabel,
  type SqlResultSession,
} from "./dbWorkspaceState";
import { SqlResultSessionPanel } from "./SqlResultSessionPanel";

export interface SqlResultSessionsDockProps {
  sqlTabId: string;
  sessions: SqlResultSession[];
  activeSessionId: string | null;
  onActiveSessionChange: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
}

export const SqlResultSessionsDock = memo(function SqlResultSessionsDock({
  sqlTabId,
  sessions,
  activeSessionId,
  onActiveSessionChange,
  onCloseSession,
}: SqlResultSessionsDockProps) {
  const layoutRef = useRef<SerializedDockview | null>(null);

  const dockTabs = useMemo<DockableTab[]>(
    () =>
      sessions.map((session, index) => ({
        id: session.id,
        label: makeSqlResultSessionLabel(index + 1),
        panelType: "sql-result",
        tooltip: session.sql.replace(/\s+/g, " ").trim(),
        closable: true,
      })),
    [sessions],
  );

  const resolvedActiveId =
    activeSessionId && sessions.some((item) => item.id === activeSessionId)
      ? activeSessionId
      : sessions[sessions.length - 1]?.id ?? "";

  const panelContentKeysByTab = useMemo(() => {
    const keys: Record<string, string> = {};
    for (const session of sessions) {
      keys[session.id] = [
        session.running ? "1" : "0",
        session.error ? "1" : "0",
        session.result
          ? `${session.result.columns.length}:${session.result.rows.length}`
          : "0",
        String(session.resultPage ?? 0),
      ].join("|");
    }
    return keys;
  }, [sessions]);

  const renderPanel = useCallback(
    (sessionId: string) => {
      const session = sessions.find((item) => item.id === sessionId);
      if (!session) return null;
      return <SqlResultSessionPanel sqlTabId={sqlTabId} session={session} />;
    },
    [sqlTabId, sessions],
  );

  const handleLayoutChange = useCallback((layout: SerializedDockview | null) => {
    layoutRef.current = layout;
  }, []);

  return (
    <DockableWorkspace
      className="db-sql-results-dock"
      tabs={dockTabs}
      activeTabId={resolvedActiveId}
      onActiveTabChange={onActiveSessionChange}
      onCloseTab={onCloseSession}
      savedLayout={layoutRef.current}
      onSavedLayoutChange={handleLayoutChange}
      renderPanel={renderPanel}
      panelContentKeysByTab={panelContentKeysByTab}
      enableTabGroups={false}
      defaultHeaderPosition="top"
      windowControl={false}
    />
  );
});
