import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../i18n";
import { resolveResourceById } from "../../stores/connectionStore";
import type { TopbarTabDef } from "../../stores/topbarStore";
import {
  useTerminalStore,
  type TerminalSession,
} from "../../stores/terminalStore";
import type { TerminalConnectionStatus } from "../../stores/terminalTypes";
import { resolveSessionActivityAt } from "../../stores/terminalSessionActivity";
import { useBlocksStore, type TerminalBlock } from "../../stores/blocksStore";
import { Button } from "../../components/ui/Button";
import { ModuleDockTitle } from "../../components/dock/ModuleDockTitle";
import {
  mergeConnectionOrder,
  moveConnectionInOrder,
  readConnectionOrder,
  sortConnectionGroups,
  writeConnectionOrder,
} from "./terminalConnectionOrder";

const EXPANDED_STORAGE_KEY = "omnipanel-terminal-session-tree-expanded";
const CONNECTION_POINTER_DRAG_THRESHOLD_PX = 6;

function isConnectionPointerDragExcluded(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  return Boolean(target.closest(".drag-ignore, button"));
}

type ConnectionGroup = {
  resourceId: string;
  name: string;
  sessions: TerminalSession[];
};

function readExpandedMap(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(EXPANDED_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, boolean>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeExpandedMap(map: Record<string, boolean>): void {
  localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(map));
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 2_592_000_000) return `${Math.floor(diff / 86_400_000)}d`;
  return `${Math.floor(diff / 2_592_000_000)}mo`;
}

function resolveActiveSessionId(
  activeSessionId: string | null,
  activeTabId: string | null,
  tabs: Array<{ id: string; sessionId: string }>,
): string | null {
  if (activeSessionId) return activeSessionId;
  const tab = tabs.find((item) => item.id === activeTabId);
  return tab?.sessionId ?? activeTabId;
}

function connectionStatusToTopbarStatus(
  status: TerminalConnectionStatus,
): TopbarTabDef["status"] {
  if (status === "connected") return "connected";
  if (status === "connecting") return "connecting";
  if (status === "disconnected") return "offline";
  return "idle";
}

function sessionStatusDotClass(status: TopbarTabDef["status"]): string {
  if (status === "connected" || status === "online") return "online";
  if (status === "connecting") return "connecting";
  if (status === "offline") return "offline";
  return "idle";
}

function resolveSessionConnectionStatus(
  sessionId: string,
  tabs: Array<{ sessionId: string; status: TerminalConnectionStatus }>,
  detachedRuntime: Record<string, { status: TerminalConnectionStatus }>,
): TopbarTabDef["status"] {
  const tab = tabs.find((item) => item.sessionId === sessionId);
  if (tab) return connectionStatusToTopbarStatus(tab.status);
  const detached = detachedRuntime[sessionId];
  if (detached) return connectionStatusToTopbarStatus(detached.status);
  return "idle";
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14" aria-hidden>
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
    </svg>
  );
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      width="12"
      height="12"
      aria-hidden
      className={`term-session-tree__chevron${expanded ? " is-expanded" : ""}`}
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function SessionRow({
  session,
  activityAt,
  isActive,
  status,
  onSelect,
  onEnd,
}: {
  session: TerminalSession;
  activityAt: number;
  isActive: boolean;
  status: TopbarTabDef["status"];
  onSelect: () => void;
  onEnd: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className={`term-session-tree__session${isActive ? " is-active" : ""}`}>
      <button type="button" className="term-session-tree__session-btn" onClick={onSelect}>
        <span
          className={`topbar-tab-dot ${sessionStatusDotClass(status)}`}
          aria-hidden
        />
        <span className="term-session-tree__session-title">{session.title}</span>
        <span className="term-session-tree__session-time">
          {formatRelativeTime(activityAt)}
        </span>
      </button>
      <button
        type="button"
        className="term-session-tree__session-end drag-ignore"
        title={t("terminal.sessions.end")}
        onClick={(e) => {
          e.stopPropagation();
          onEnd();
        }}
      >
        ×
      </button>
    </div>
  );
}

function ConnectionGroupBlock({
  group,
  blocksBySession,
  expanded,
  activeSessionId,
  sessionStatusById,
  dropHint,
  draggingSource,
  onToggle,
  onSelectSession,
  onCreateSession,
  onEndSession,
  onConnectionPointerDown,
}: {
  group: ConnectionGroup;
  blocksBySession: Record<string, TerminalBlock[]>;
  expanded: boolean;
  activeSessionId: string | null;
  sessionStatusById: Map<string, TopbarTabDef["status"]>;
  dropHint: "before" | "after" | null;
  draggingSource: boolean;
  onToggle: () => void;
  onSelectSession: (sessionId: string) => void;
  onCreateSession: (resourceId: string, title: string) => void;
  onEndSession: (sessionId: string) => void;
  onConnectionPointerDown: (
    event: ReactPointerEvent<HTMLDivElement>,
    resourceId: string,
  ) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="term-session-tree__group">
      <div
        className={`term-session-tree__connection${dropHint === "before" ? " is-drop-before" : ""}${dropHint === "after" ? " is-drop-after" : ""}${draggingSource ? " is-dragging-source" : ""}`}
        data-connection-id={group.resourceId}
        title={t("terminal.sessions.reorderConnection")}
        onPointerDown={(event) => onConnectionPointerDown(event, group.resourceId)}
      >
        <button
          type="button"
          className="term-session-tree__connection-toggle drag-ignore"
          onClick={onToggle}
          aria-expanded={expanded}
        >
          <ChevronIcon expanded={expanded} />
        </button>
        <div
          role="button"
          tabIndex={0}
          className="term-session-tree__connection-main"
          onClick={onToggle}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onToggle();
            }
          }}
        >
          <span className="term-session-tree__folder" aria-hidden>
            <FolderIcon />
          </span>
          <span className="term-session-tree__connection-name">{group.name}</span>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          className="term-session-tree__connection-add drag-ignore"
          title={t("terminal.sessions.newUnderConnection")}
          onClick={() => onCreateSession(group.resourceId, group.name)}
        >
          +
        </Button>
      </div>
      {expanded ? (
        <div className="term-session-tree__sessions">
          {group.sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              activityAt={resolveSessionActivityAt(session, blocksBySession)}
              isActive={activeSessionId === session.id}
              status={sessionStatusById.get(session.id) ?? "idle"}
              onSelect={() => onSelectSession(session.id)}
              onEnd={() => onEndSession(session.id)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export interface TerminalSessionSidebarProps {
  onSelectSession: (sessionId: string) => void;
  onCreateSession: (resourceId: string, title: string) => void;
  onEndSession: (sessionId: string) => void;
}

export function TerminalSessionSidebar({
  onSelectSession,
  onCreateSession,
  onEndSession,
}: TerminalSessionSidebarProps) {
  const { t } = useI18n();
  const sessions = useTerminalStore((s) => s.sessions);
  const activeSessionId = useTerminalStore((s) => s.activeSessionId);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const tabs = useTerminalStore((s) => s.tabs);
  const detachedRuntime = useTerminalStore((s) => s.detachedRuntime);
  const blocksBySession = useBlocksStore((s) => s.blocks);

  const sessionStatusById = useMemo(() => {
    const map = new Map<string, TopbarTabDef["status"]>();
    for (const session of sessions) {
      if (session.lifecycle === "ended") continue;
      map.set(
        session.id,
        resolveSessionConnectionStatus(session.id, tabs, detachedRuntime),
      );
    }
    return map;
  }, [detachedRuntime, sessions, tabs]);

  const resolvedActiveSessionId = useMemo(
    () => resolveActiveSessionId(activeSessionId, activeTabId, tabs),
    [activeSessionId, activeTabId, tabs],
  );

  const [expandedMap, setExpandedMap] = useState<Record<string, boolean>>(readExpandedMap);
  const [connectionOrder, setConnectionOrder] = useState<string[]>(readConnectionOrder);
  const [draggingSourceId, setDraggingSourceId] = useState<string | null>(null);
  const [isPointerDragging, setIsPointerDragging] = useState(false);
  const [dropTarget, setDropTarget] = useState<{
    resourceId: string;
    position: "before" | "after";
  } | null>(null);
  const treeBodyRef = useRef<HTMLDivElement>(null);
  const connectionGroupsRef = useRef<ConnectionGroup[]>([]);
  const connectionOrderRef = useRef(connectionOrder);
  const skipNextToggleRef = useRef(false);
  const pointerDragRef = useRef<{
    resourceId: string;
    pointerId: number;
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);

  connectionOrderRef.current = connectionOrder;

  const connectionGroups = useMemo((): ConnectionGroup[] => {
    const map = new Map<string, TerminalSession[]>();
    for (const session of sessions) {
      if (session.lifecycle === "ended") continue;
      const resourceId = session.session.resourceId;
      const list = map.get(resourceId) ?? [];
      list.push(session);
      map.set(resourceId, list);
    }

    const groups = [...map.entries()]
      .map(([resourceId, groupSessions]) => {
        const sorted = [...groupSessions].sort(
          (a, b) =>
            resolveSessionActivityAt(b, blocksBySession) -
            resolveSessionActivityAt(a, blocksBySession),
        );
        return {
          resourceId,
          name: resolveResourceById(resourceId)?.name ?? sorted[0]?.title ?? resourceId,
          sessions: sorted,
        };
      })
      .filter((group) => group.sessions.length > 0);

    const mergedOrder = mergeConnectionOrder(
      connectionOrder,
      groups.map((group) => group.resourceId),
    );
    return sortConnectionGroups(groups, mergedOrder);
  }, [sessions, connectionOrder, blocksBySession]);

  connectionGroupsRef.current = connectionGroups;

  useEffect(() => {
    const resourceIds = connectionGroups.map((group) => group.resourceId);
    if (resourceIds.length === 0) return;
    const merged = mergeConnectionOrder(connectionOrder, resourceIds);
    if (merged.join("|") !== connectionOrder.join("|")) {
      setConnectionOrder(merged);
      writeConnectionOrder(merged);
    }
  }, [connectionGroups, connectionOrder]);

  const setExpanded = useCallback((resourceId: string, expanded: boolean) => {
    setExpandedMap((prev) => {
      const next = { ...prev, [resourceId]: expanded };
      writeExpandedMap(next);
      return next;
    });
  }, []);

  const toggleExpanded = useCallback(
    (resourceId: string) => {
      if (skipNextToggleRef.current) {
        skipNextToggleRef.current = false;
        return;
      }
      const current = expandedMap[resourceId] ?? true;
      setExpanded(resourceId, !current);
    },
    [expandedMap, setExpanded],
  );

  const cleanupPointerDrag = useCallback(() => {
    pointerDragRef.current = null;
    setDraggingSourceId(null);
    setIsPointerDragging(false);
    setDropTarget(null);
    document.body.classList.remove("term-session-tree--dragging");
    document.body.style.cursor = "";
    document.documentElement.style.cursor = "";
  }, []);

  const resolveConnectionDropFromPointer = useCallback(
    (clientX: number, clientY: number): { resourceId: string; position: "before" | "after" } | null => {
      const treeBody = treeBodyRef.current;
      if (!treeBody) return null;

      const connections = [...treeBody.querySelectorAll<HTMLElement>("[data-connection-id]")];
      for (const connectionEl of connections) {
        const rect = connectionEl.getBoundingClientRect();
        if (
          clientX < rect.left ||
          clientX > rect.right ||
          clientY < rect.top ||
          clientY > rect.bottom
        ) {
          continue;
        }
        const resourceId = connectionEl.dataset.connectionId;
        if (!resourceId) continue;
        const position = clientY < rect.top + rect.height / 2 ? "before" : "after";
        return { resourceId, position };
      }

      const groups = connectionGroupsRef.current;
      if (groups.length === 0) return null;

      const lastConnection = connections[connections.length - 1];
      const lastGroup = groups[groups.length - 1];
      if (!lastConnection || !lastGroup) return null;

      const rect = lastConnection.getBoundingClientRect();
      if (clientY > rect.bottom + 4) {
        return { resourceId: lastGroup.resourceId, position: "after" };
      }
      return null;
    },
    [],
  );

  const handleConnectionPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, resourceId: string) => {
      if (event.button !== 0) return;
      if (isConnectionPointerDragExcluded(event.target)) return;
      pointerDragRef.current = {
        resourceId,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        active: false,
      };
    },
    [],
  );

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const session = pointerDragRef.current;
      if (!session || event.pointerId !== session.pointerId) return;

      const dx = event.clientX - session.startX;
      const dy = event.clientY - session.startY;
      if (!session.active) {
        if (Math.hypot(dx, dy) < CONNECTION_POINTER_DRAG_THRESHOLD_PX) return;
        session.active = true;
        setDraggingSourceId(session.resourceId);
        setIsPointerDragging(true);
        document.body.classList.add("term-session-tree--dragging");
        document.body.style.cursor = "grabbing";
        document.documentElement.style.cursor = "grabbing";
      }

      event.preventDefault();
      setDropTarget(resolveConnectionDropFromPointer(event.clientX, event.clientY));
    };

    const finishPointerDrag = (event: PointerEvent) => {
      const session = pointerDragRef.current;
      if (!session || event.pointerId !== session.pointerId) return;

      if (session.active) {
        const hint = resolveConnectionDropFromPointer(event.clientX, event.clientY);
        if (hint && hint.resourceId !== session.resourceId) {
          const resourceIds = connectionGroupsRef.current.map((group) => group.resourceId);
          const currentOrder = mergeConnectionOrder(connectionOrderRef.current, resourceIds);
          const next = moveConnectionInOrder(
            currentOrder,
            session.resourceId,
            hint.resourceId,
            hint.position,
          );
          setConnectionOrder(next);
          writeConnectionOrder(next);
        }
        skipNextToggleRef.current = true;
      }

      cleanupPointerDrag();
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finishPointerDrag);
    window.addEventListener("pointercancel", finishPointerDrag);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finishPointerDrag);
      window.removeEventListener("pointercancel", finishPointerDrag);
      cleanupPointerDrag();
    };
  }, [cleanupPointerDrag, resolveConnectionDropFromPointer]);

  useEffect(() => {
    if (!resolvedActiveSessionId) return;
    const session = sessions.find((item) => item.id === resolvedActiveSessionId);
    if (session) {
      setExpanded(session.session.resourceId, true);
    }
  }, [resolvedActiveSessionId, sessions, setExpanded]);

  return (
    <div className="term-session-tree">
      {isPointerDragging
        ? createPortal(<div className="term-session-tree__drag-cursor-layer" aria-hidden />, document.body)
        : null}
      <div className="term-session-tree__module-header">
        <ModuleDockTitle>{t("routes.terminal")}</ModuleDockTitle>
      </div>
      <div className="term-session-tree__body" ref={treeBodyRef}>
        {connectionGroups.length === 0 ? (
          <div className="term-session-tree__empty">{t("terminal.sessions.empty")}</div>
        ) : (
          connectionGroups.map((group) => (
            <ConnectionGroupBlock
              key={group.resourceId}
              group={group}
              blocksBySession={blocksBySession}
              expanded={expandedMap[group.resourceId] ?? true}
              activeSessionId={resolvedActiveSessionId}
              sessionStatusById={sessionStatusById}
              dropHint={
                dropTarget?.resourceId === group.resourceId ? dropTarget.position : null
              }
              draggingSource={draggingSourceId === group.resourceId}
              onToggle={() => toggleExpanded(group.resourceId)}
              onSelectSession={onSelectSession}
              onCreateSession={onCreateSession}
              onEndSession={onEndSession}
              onConnectionPointerDown={handleConnectionPointerDown}
            />
          ))
        )}
      </div>
    </div>
  );
}
