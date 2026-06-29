import { memo, useCallback, useEffect, useMemo, useRef } from "react";
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
  const pendingActiveSessionIdRef = useRef<string | null>(null);

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

  useEffect(() => {
    pendingActiveSessionIdRef.current = resolvedActiveId || null;
  }, [resolvedActiveId]);

  const handleActiveSessionChange = useCallback(
    (sessionId: string) => {
      if (sessionId === pendingActiveSessionIdRef.current) {
        return;
      }
      pendingActiveSessionIdRef.current = sessionId;
      onActiveSessionChange(sessionId);
    },
    [onActiveSessionChange],
  );

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

  return (
    <DockableWorkspace
      className="db-sql-results-dock"
      tabs={dockTabs}
      activeTabId={resolvedActiveId}
      onActiveTabChange={handleActiveSessionChange}
      onCloseTab={onCloseSession}
      savedLayout={null}
      onSavedLayoutChange={() => {}}
      renderPanel={renderPanel}
      panelContentKeysByTab={panelContentKeysByTab}
      enableTabGroups={false}
      defaultHeaderPosition="top"
      windowControl={false}
    />
  );
});
