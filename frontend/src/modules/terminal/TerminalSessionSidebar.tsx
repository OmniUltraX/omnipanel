import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
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
import { showToast } from "../../stores/toastStore";
import { QuickInputDialog } from "../../components/ui/form/QuickInputDialog";
import { ContextMenu, type ContextMenuItem } from "../../components/ui/menu/ContextMenu";
import {
  SidebarTreeEmpty,
  SidebarTreeNode,
  SidebarTreeRoot,
  SidebarTreeSelectionProvider,
} from "@/components/ui/sidebar-tree";
import {
  mergeConnectionOrder,
  moveConnectionInOrder,
  readConnectionOrder,
  sortConnectionGroups,
  writeConnectionOrder,
} from "./terminalConnectionOrder";
import {
  renameSessionWithAi,
  subscribeAiNamingState,
} from "./sessionAutoName";

const EXPANDED_STORAGE_KEY = "omnipanel-terminal-session-tree-expanded";
const CONNECTION_POINTER_DRAG_THRESHOLD_PX = 6;

function isConnectionPointerDragExcluded(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  return Boolean(
    target.closest(".sidebar-tree-arrow, .tree-action-btn, .tree-node-actions, button"),
  );
}

function makeConnectionTreeKey(resourceId: string): string {
  return `connection:${resourceId}`;
}

function makeSessionTreeKey(sessionId: string): string {
  return `session:${sessionId}`;
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
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="13" height="13" aria-hidden>
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
    </svg>
  );
}

function SessionIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="13" height="13" aria-hidden>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
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
  const [sessionCtxMenu, setSessionCtxMenu] = useState<{
    x: number;
    y: number;
    session: TerminalSession;
  } | null>(null);
  const [renameTarget, setRenameTarget] = useState<{
    sessionId: string;
    currentTitle: string;
  } | null>(null);
  const [aiNamingIds, setAiNamingIds] = useState<Set<string>>(new Set());
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
    const unsub = subscribeAiNamingState((sessionId, pending) => {
      setAiNamingIds((prev) => {
        const next = new Set(prev);
        if (pending) next.add(sessionId);
        else next.delete(sessionId);
        return next;
      });
    });
    return unsub;
  }, []);

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

  const handleSessionContextMenu = useCallback(
    (event: ReactMouseEvent, sessionId: string) => {
      event.preventDefault();
      event.stopPropagation();
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) return;
      setSessionCtxMenu({ x: event.clientX, y: event.clientY, session });
    },
    [sessions],
  );

  const handleRenameSession = useCallback((session: TerminalSession) => {
    setSessionCtxMenu(null);
    setRenameTarget({
      sessionId: session.id,
      currentTitle: session.title,
    });
  }, []);

  const handleAiRenameSession = useCallback(
    (session: TerminalSession) => {
      setSessionCtxMenu(null);
      void renameSessionWithAi(session.id).then((result) => {
        if (!result.ok) {
          if (result.reason === "no-provider") {
            showToast(t("terminal.sessions.aiRenameNoProvider"));
          } else if (result.reason === "no-context") {
            showToast(t("terminal.sessions.aiRenameNoContext"));
          } else {
            showToast(t("terminal.sessions.aiRenameFailed"));
          }
        }
      });
    },
    [t],
  );

  const handleCopySession = useCallback((session: TerminalSession) => {
    setSessionCtxMenu(null);
    const copyTitle = `${session.title} (副本)`;
    const newId = `sess-copy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    useTerminalStore.getState().createSession(copyTitle, session.session, newId);
  }, []);

  const handleConfirmSessionRename = useCallback(
    (trimmed: string) => {
      if (!renameTarget) return;
      if (trimmed !== renameTarget.currentTitle) {
        useTerminalStore.getState().renameSession(renameTarget.sessionId, trimmed);
      }
      setRenameTarget(null);
    },
    [renameTarget],
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
      <SidebarTreeSelectionProvider>
        <div ref={treeBodyRef} className="term-session-tree__body">
          <SidebarTreeRoot className="sidebar-tree-root">
          {connectionGroups.length === 0 ? (
            <SidebarTreeEmpty>{t("terminal.sessions.empty")}</SidebarTreeEmpty>
          ) : (
            connectionGroups.map((group) => {
              const expanded = expandedMap[group.resourceId] ?? true;
              const dropHint =
                dropTarget?.resourceId === group.resourceId ? dropTarget.position : null;
              const draggingSource = draggingSourceId === group.resourceId;
              const connectionKey = makeConnectionTreeKey(group.resourceId);

              return (
                <div key={group.resourceId} className="server-tree-category term-session-tree__group">
                  <SidebarTreeNode
                    depth={0}
                    module="terminal"
                    nodeType="connection"
                    treeKey={connectionKey}
                    label={group.name}
                    icon={<FolderIcon />}
                    hasChildren
                    expanded={expanded}
                    active={group.sessions.some((session) => session.id === resolvedActiveSessionId)}
                    className={[
                      "term-session-tree__connection-node",
                      dropHint === "before" ? "term-session-tree__connection-node--drop-before" : "",
                      dropHint === "after" ? "term-session-tree__connection-node--drop-after" : "",
                      draggingSource ? "term-session-tree__connection-node--dragging" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    dataAttrs={{ "data-connection-id": group.resourceId }}
                    onToggle={() => toggleExpanded(group.resourceId)}
                    onActivate={() => toggleExpanded(group.resourceId)}
                    onPointerDown={(event) => handleConnectionPointerDown(event, group.resourceId)}
                    contextMenuItems={[
                      {
                        id: "new-session",
                        label: t("terminal.sessions.newUnderConnection"),
                        onClick: () => onCreateSession(group.resourceId, group.name),
                      },
                    ]}
                    trailing={<span className="server-tree-badge">{group.sessions.length}</span>}
                  />
                  {expanded ? (
                    <div className="server-tree-children">
                      {group.sessions.map((session) => {
                        const activityAt = resolveSessionActivityAt(session, blocksBySession);
                        const isActive = resolvedActiveSessionId === session.id;
                        const status = sessionStatusById.get(session.id) ?? "idle";
                        const isAiNaming = aiNamingIds.has(session.id);

                        return (
                          <SidebarTreeNode
                            key={session.id}
                            depth={1}
                            module="terminal"
                            nodeType="session"
                            treeKey={makeSessionTreeKey(session.id)}
                            label={session.title}
                            icon={<SessionIcon />}
                            hasChildren={false}
                            expanded={false}
                            active={isActive}
                            onToggle={() => {}}
                            onSelect={() => onSelectSession(session.id)}
                            onActivate={() => onSelectSession(session.id)}
                            onContextMenu={(event) => handleSessionContextMenu(event, session.id)}
                            prefix={
                              <span
                                className={`topbar-tab-dot ${sessionStatusDotClass(status)}`}
                                aria-hidden
                              />
                            }
                            afterLabel={
                              isAiNaming ? (
                                <span
                                  className="term-session-tree__ai-spinner"
                                  title={t("terminal.sessions.aiRenaming")}
                                  aria-label={t("terminal.sessions.aiRenaming")}
                                />
                              ) : undefined
                            }
                            trailing={
                              <>
                                <span className="tree-meta term-session-tree__session-time">
                                  {formatRelativeTime(activityAt)}
                                </span>
                                <div className="tree-node-actions">
                                  <button
                                    type="button"
                                    className="tree-action-btn tree-action-btn--danger"
                                    title={t("terminal.sessions.end")}
                                    aria-label={t("terminal.sessions.end")}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      onEndSession(session.id);
                                    }}
                                  >
                                    ×
                                  </button>
                                </div>
                              </>
                            }
                          />
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
          </SidebarTreeRoot>
        </div>
      </SidebarTreeSelectionProvider>
      {sessionCtxMenu && (() => {
        const items: ContextMenuItem[] = [
          {
            id: "session-open",
            label: t("terminal.sessions.open"),
            onClick: () => {
              onSelectSession(sessionCtxMenu.session.id);
              setSessionCtxMenu(null);
            },
          },
          {
            id: "session-rename",
            label: t("shell.topbar.rename"),
            onClick: () => handleRenameSession(sessionCtxMenu.session),
          },
          {
            id: "session-ai-rename",
            label: aiNamingIds.has(sessionCtxMenu.session.id)
              ? t("terminal.sessions.aiRenaming")
              : t("terminal.sessions.aiRename"),
            disabled: aiNamingIds.has(sessionCtxMenu.session.id),
            onClick: () => handleAiRenameSession(sessionCtxMenu.session),
          },
          {
            id: "session-copy",
            label: t("terminal.sessions.copy"),
            onClick: () => handleCopySession(sessionCtxMenu.session),
          },
          { id: "session-sep-1", separator: true, label: "" },
          {
            id: "session-end",
            label: t("terminal.sessions.end"),
            danger: true,
            onClick: () => {
              onEndSession(sessionCtxMenu.session.id);
              setSessionCtxMenu(null);
            },
          },
        ];
        return (
          <ContextMenu
            items={items}
            position={{ x: sessionCtxMenu.x, y: sessionCtxMenu.y }}
            onClose={() => setSessionCtxMenu(null)}
          />
        );
      })()}
      <QuickInputDialog
        open={renameTarget != null}
        title={t("shell.topbar.rename")}
        subtitle={renameTarget?.currentTitle}
        defaultValue={renameTarget?.currentTitle ?? ""}
        onCancel={() => setRenameTarget(null)}
        onConfirm={handleConfirmSessionRename}
      />
    </div>
  );
}
