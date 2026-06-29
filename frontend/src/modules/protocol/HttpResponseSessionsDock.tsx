import { memo, useCallback, useMemo, useRef } from "react";
import type { SerializedDockview } from "dockview-core";
import { DockableWorkspace, type DockableTab } from "../../components/dock";
import type { HttpResponseSession } from "./httpResponseState";
import { HttpResponseSessionPanel } from "./HttpResponseSessionPanel";

export interface HttpResponseSessionsDockProps {
  sessions: HttpResponseSession[];
  activeSessionId: string | null;
  onActiveSessionChange: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
}

export const HttpResponseSessionsDock = memo(function HttpResponseSessionsDock({
  sessions,
  activeSessionId,
  onActiveSessionChange,
  onCloseSession,
}: HttpResponseSessionsDockProps) {
  const layoutRef = useRef<SerializedDockview | null>(null);

  const dockTabs = useMemo<DockableTab[]>(
    () =>
      sessions.map((session) => ({
        id: session.id,
        label: session.label,
        panelType: "http-response",
        tooltip: `${session.response.status} ${session.response.statusText}`.trim(),
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
        session.response.status,
        session.response.body.length,
        Object.keys(session.response.headers).length,
      ].join("|");
    }
    return keys;
  }, [sessions]);

  const renderPanel = useCallback(
    (sessionId: string) => {
      const session = sessions.find((item) => item.id === sessionId);
      if (!session) return null;
      return <HttpResponseSessionPanel session={session} />;
    },
    [sessions],
  );

  const handleLayoutChange = useCallback((layout: SerializedDockview | null) => {
    layoutRef.current = layout;
  }, []);

  return (
    <DockableWorkspace
      className="http-response-dock"
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
