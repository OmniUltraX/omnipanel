import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { DockableWorkspace, type DockableTab } from "../../../components/dock";
import { ContextMenu, type ContextMenuItem } from "../../../components/ui/ContextMenu";
import { useI18n } from "../../../i18n";
import {
  makeSqlResultSessionLabel,
  type SqlResultSession,
} from "../workspace/dbWorkspaceState";
import { SqlResultSessionPanel } from "./SqlResultSessionPanel";

export interface SqlResultSessionsDockProps {
  sqlTabId: string;
  sessions: SqlResultSession[];
  activeSessionId: string | null;
  onActiveSessionChange: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  onPinSession: (sessionId: string, pinned: boolean) => void;
}

export const SqlResultSessionsDock = memo(function SqlResultSessionsDock({
  sqlTabId,
  sessions,
  activeSessionId,
  onActiveSessionChange,
  onCloseSession,
  onPinSession,
}: SqlResultSessionsDockProps) {
  const { t } = useI18n();
  const pendingActiveSessionIdRef = useRef<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    sessionId: string;
  } | null>(null);

  const dockTabs = useMemo<DockableTab[]>(
    () =>
      sessions.map((session, index) => {
        const compactSql = session.sql.replace(/\s+/g, " ").trim();
        const tooltipPrefix = session.pinned
          ? ""
          : `${t("database.results.temporarySession")} · `;
        return {
          id: session.id,
          label: makeSqlResultSessionLabel(index + 1),
          panelType: "sql-result",
          tooltip: `${tooltipPrefix}${compactSql}`,
          closable: true,
          preview: !session.pinned,
        };
      }),
    [sessions, t],
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

  const handleTabDoubleClick = useCallback(
    (sessionId: string) => {
      const session = sessions.find((item) => item.id === sessionId);
      if (session && !session.pinned) {
        onPinSession(sessionId, true);
      }
    },
    [sessions, onPinSession],
  );

  const handleTabContextMenu = useCallback(
    (event: MouseEvent, sessionId: string) => {
      event.preventDefault();
      setContextMenu({ x: event.clientX, y: event.clientY, sessionId });
    },
    [],
  );

  const contextMenuSession = contextMenu
    ? sessions.find((item) => item.id === contextMenu.sessionId)
    : undefined;

  const contextMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!contextMenuSession) return [];
    const pinned = Boolean(contextMenuSession.pinned);
    return [
      {
        id: "pin-toggle",
        label: pinned
          ? t("database.results.unpinSession")
          : t("database.results.pinSession"),
        onClick: () => onPinSession(contextMenuSession.id, !pinned),
      },
      {
        id: "close",
        label: t("database.results.closeSession"),
        onClick: () => onCloseSession(contextMenuSession.id),
      },
    ];
  }, [contextMenuSession, onCloseSession, onPinSession, t]);

  const panelContentKeysByTab = useMemo(() => {
    const keys: Record<string, string> = {};
    for (const session of sessions) {
      keys[session.id] = [
        session.pinned ? "1" : "0",
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
    <>
      <DockableWorkspace
        className="db-sql-results-dock"
        tabs={dockTabs}
        activeTabId={resolvedActiveId}
        onActiveTabChange={handleActiveSessionChange}
        onCloseTab={onCloseSession}
        onTabDoubleClick={handleTabDoubleClick}
        onTabContextMenu={handleTabContextMenu}
        savedLayout={null}
        onSavedLayoutChange={() => {}}
        renderPanel={renderPanel}
        panelContentKeysByTab={panelContentKeysByTab}
        enableTabGroups={false}
        defaultHeaderPosition="top"
        windowControl={false}
      />
      {contextMenu ? (
        <ContextMenu
          items={contextMenuItems}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
    </>
  );
});
