import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type {
  TerminalConnectionStatus,
  TerminalPane,
  TerminalSessionInfo,
  TerminalSessionType,
  TerminalTab,
  TerminalTabInput,
} from "./terminalTypes";
import {
  createSessionEntity,
  defaultSessionInfo,
  migrateLegacyTabsToSessions,
  normalizePersistedSession,
  syncSessionCounterFromIds,
  tabFromSession,
  type TerminalDetachedRuntime,
  type TerminalSession,
} from "./terminalSessionModel";

export type {
  TerminalConnectionStatus,
  TerminalPane,
  TerminalSessionInfo,
  TerminalSessionType,
  TerminalTab,
  TerminalTabInput,
} from "./terminalTypes";
export type { TerminalSession } from "./terminalSessionModel";
export { createTerminalSessionId, createTerminalSessionId as createTerminalTabId } from "./terminalSessionModel";

let tabCounter = 0;

function syncTabCounterFromTabs(tabs: Array<{ id: string }>): void {
  let max = 0;
  for (const tab of tabs) {
    const match = /^tab-(\d+)$/.exec(tab.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  tabCounter = max;
}

/** @deprecated 工作区快照等仍可能生成 tab-N；新会话请用 createTerminalSessionId */
export function createLegacyTabId() {
  tabCounter += 1;
  return `tab-${tabCounter}`;
}

interface TerminalState {
  sessions: TerminalSession[];
  tabs: TerminalTab[];
  activeTabId: string | null;
  activeSessionId: string | null;
  /** Tab 关闭后保留的后端连接，供再次打开时 attach */
  detachedRuntime: Record<string, TerminalDetachedRuntime>;
  embeddedPanes: Record<string, TerminalPane>;

  getSession: (sessionId: string) => TerminalSession | undefined;
  listSessionsForResource: (resourceId: string) => TerminalSession[];
  createSession: (title: string, session: TerminalSessionInfo, id?: string) => string;
  openSessionTab: (sessionId: string) => string;
  closeTabOnly: (sessionId: string) => void;
  endSession: (sessionId: string) => void;
  renameSession: (sessionId: string, title: string) => void;
  touchSession: (sessionId: string, at?: number) => void;

  addTab: (tab: TerminalTabInput) => string;
  removeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  setActiveSession: (sessionId: string) => void;
  setTerminal: (tabId: string, terminal: TerminalTab["terminal"]) => void;
  setStatus: (sessionId: string, status: TerminalConnectionStatus) => void;
  setBackendSessionId: (sessionId: string, backendSessionId: string | null) => void;
  setSessionCwd: (sessionId: string, cwd: string) => void;
  setTabResource: (tabId: string, session: TerminalSessionInfo) => void;
  renameTab: (tabId: string, title: string) => void;
  setTabWorkspaceOnly: (tabId: string, workspaceOnly: boolean) => void;
  upsertEmbeddedPane: (
    pane: Omit<TerminalPane, "terminal" | "status" | "backendSessionId">,
  ) => string;
  removeEmbeddedPane: (paneId: string) => void;
  findTabByResourceId: (
    resourceId: string,
    type?: TerminalSessionType,
  ) => TerminalTab | undefined;
  openOrFocusSshTab: (hostId: string, title: string) => string;
  openOrFocusLocalTab: (title?: string) => string;
  addLocalTerminalTab: (title?: string, workspaceId?: string) => string;
  addSshTerminalTab: (hostId: string, title: string, workspaceId?: string) => string;
}

function updateTabById(
  tabs: TerminalTab[],
  tabId: string,
  updater: (tab: TerminalTab) => TerminalTab,
): TerminalTab[] {
  return tabs.map((tab) => (tab.id === tabId ? updater(tab) : tab));
}

function updateSessionById(
  sessions: TerminalSession[],
  sessionId: string,
  updater: (session: TerminalSession) => TerminalSession,
): TerminalSession[] {
  return sessions.map((s) => (s.id === sessionId ? updater(s) : s));
}

function getRuntimeForSession(
  state: TerminalState,
  sessionId: string,
): TerminalDetachedRuntime | undefined {
  const tab = state.tabs.find((t) => t.sessionId === sessionId);
  if (tab) {
    return { backendSessionId: tab.backendSessionId, status: tab.status };
  }
  return state.detachedRuntime[sessionId];
}

export function findTerminalSession(
  id: string,
): { kind: "tab"; tab: TerminalTab } | { kind: "pane"; pane: TerminalPane } | undefined {
  const state = useTerminalStore.getState();
  const tab = state.tabs.find((item) => item.id === id || item.sessionId === id);
  if (tab) return { kind: "tab", tab };
  const pane = state.embeddedPanes[id];
  if (pane) return { kind: "pane", pane };
  return undefined;
}

export function findTerminalPane(id: string): TerminalPane | undefined {
  const found = findTerminalSession(id);
  if (found?.kind === "pane") return found.pane;
  if (found?.kind === "tab") {
    const tab = found.tab;
    return {
      id: tab.sessionId,
      backendSessionId: tab.backendSessionId,
      title: tab.title,
      type: tab.session.type,
      resourceId: tab.session.resourceId,
      shellLabel: tab.session.shellLabel,
      cwd: tab.session.cwd,
      purpose: tab.session.purpose,
      commandPack: tab.session.commandPack,
      terminal: tab.terminal,
      status: tab.status,
    };
  }
  const state = useTerminalStore.getState();
  const entity = state.sessions.find((s) => s.id === id);
  if (!entity) return undefined;
  const runtime = state.detachedRuntime[id];
  return {
    id: entity.id,
    backendSessionId: runtime?.backendSessionId ?? null,
    title: entity.title,
    type: entity.session.type,
    resourceId: entity.session.resourceId,
    shellLabel: entity.session.shellLabel,
    cwd: entity.session.cwd,
    purpose: entity.session.purpose,
    commandPack: entity.session.commandPack,
    terminal: null,
    status: runtime?.status ?? "disconnected",
  };
}

function createPane(
  pane: Omit<TerminalPane, "terminal" | "status" | "backendSessionId">,
): TerminalPane {
  return {
    ...pane,
    terminal: null,
    status: "connecting",
    backendSessionId: null,
  };
}

export const SSH_EMBEDDED_PANE_PREFIX = "ssh-embed:";

export function sshEmbeddedWorkspaceId(resourceId: string) {
  return `${SSH_EMBEDDED_PANE_PREFIX}${resourceId}`;
}

export function sshEmbeddedPaneId(resourceId: string) {
  return sshEmbeddedWorkspaceId(resourceId);
}

function normalizeLegacyPersistedTab(tab: unknown): TerminalTab | null {
  if (!tab || typeof tab !== "object") return null;
  const raw = tab as Record<string, unknown>;
  if (typeof raw.id !== "string" || typeof raw.title !== "string") return null;

  const legacyPanes = Array.isArray(raw.panes) ? (raw.panes as Array<Record<string, unknown>>) : null;
  const legacyPane = legacyPanes && legacyPanes.length > 0 ? legacyPanes[0] : null;
  const sessionSource: Record<string, unknown> | null =
    (raw.session as Record<string, unknown> | undefined) ??
    (legacyPane as Record<string, unknown> | undefined) ??
    null;
  if (!sessionSource) return null;

  const type: TerminalSessionType = sessionSource.type === "remote" ? "remote" : "local";
  const resourceId =
    typeof sessionSource.resourceId === "string" ? sessionSource.resourceId : "local-terminal";
  const session: TerminalSessionInfo = {
    type,
    resourceId,
    shellLabel: typeof sessionSource.shellLabel === "string" ? sessionSource.shellLabel : "Shell",
    cwd: typeof sessionSource.cwd === "string" ? sessionSource.cwd : "~/",
    purpose:
      typeof sessionSource.purpose === "string"
        ? sessionSource.purpose
        : type === "remote"
          ? "SSH Workbench"
          : "Local Workspace",
    commandPack: Array.isArray(sessionSource.commandPack)
      ? (sessionSource.commandPack as unknown[]).filter((c): c is string => typeof c === "string")
      : [],
  };
  const createdAt = typeof raw.createdAt === "number" ? raw.createdAt : Date.now();
  const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : raw.id;
  return {
    id: raw.id,
    sessionId,
    title: raw.title,
    session,
    workspaceId: raw.workspaceId as string | undefined,
    backendSessionId: null,
    status: "connecting",
    terminal: null,
    createdAt,
  };
}

const TABS_STORAGE_KEY = "omnipanel.terminalTabs.v2";
const TABS_STORAGE_VERSION = 3;

export const useTerminalStore = create<TerminalState>()(
  persist(
    (set, get) => ({
      sessions: [],
      tabs: [],
      activeTabId: null,
      activeSessionId: null,
      detachedRuntime: {},
      embeddedPanes: {},

      getSession: (sessionId) => get().sessions.find((s) => s.id === sessionId),

      listSessionsForResource: (resourceId) =>
        get().sessions.filter(
          (s) => s.session.resourceId === resourceId && s.lifecycle !== "ended",
        ),

      createSession: (title, session, id) => {
        const entity = createSessionEntity(title, session, id);
        set((state) => ({
          sessions: [...state.sessions, entity],
        }));
        return entity.id;
      },

      openSessionTab: (sessionId) => {
        const state = get();
        const entity = state.sessions.find((s) => s.id === sessionId);
        if (!entity || entity.lifecycle === "ended") return sessionId;

        const existing = state.tabs.find((t) => t.sessionId === sessionId);
        if (existing) {
          set({
            activeTabId: existing.id,
            activeSessionId: sessionId,
            sessions: updateSessionById(state.sessions, sessionId, (s) => ({
              ...s,
              lifecycle: "active",
            })),
          });
          return existing.id;
        }

        const runtime = state.detachedRuntime[sessionId];
        const tab = tabFromSession(entity, runtime);
        const { [sessionId]: _removed, ...restDetached } = state.detachedRuntime;

        set({
          sessions: updateSessionById(state.sessions, sessionId, (s) => ({
            ...s,
            lifecycle: "active",
          })),
          tabs: [...state.tabs, tab],
          detachedRuntime: restDetached,
          activeTabId: tab.id,
          activeSessionId: sessionId,
        });
        return tab.id;
      },

      closeTabOnly: (sessionIdOrTabId) => {
        set((state) => {
          const tab = state.tabs.find(
            (t) => t.sessionId === sessionIdOrTabId || t.id === sessionIdOrTabId,
          );
          if (!tab) return state;
          const sessionId = tab.sessionId;

          const detachedRuntime: Record<string, TerminalDetachedRuntime> = {
            ...state.detachedRuntime,
            [sessionId]: {
              backendSessionId: tab.backendSessionId,
              status: tab.status,
            },
          };

          const remaining = state.tabs.filter((t) => t.id !== tab.id);
          const nextActive =
            state.activeTabId === tab.id
              ? remaining.length > 0
                ? remaining[Math.max(remaining.length - 1, 0)].id
                : null
              : state.activeTabId;
          const nextSessionId = nextActive
            ? remaining.find((t) => t.id === nextActive)?.sessionId ?? null
            : null;

          return {
            tabs: remaining,
            activeTabId: nextActive,
            activeSessionId: nextSessionId,
            detachedRuntime,
            sessions: updateSessionById(state.sessions, sessionId, (s) => ({
              ...s,
              lifecycle: "suspended",
            })),
          };
        });
      },

      endSession: (sessionId) => {
        set((state) => {
          const { [sessionId]: _d, ...restDetached } = state.detachedRuntime;
          const remainingTabs = state.tabs.filter((t) => t.sessionId !== sessionId);
          const nextActive =
            state.activeSessionId === sessionId
              ? remainingTabs.length > 0
                ? remainingTabs[Math.max(remainingTabs.length - 1, 0)].id
                : null
              : state.activeTabId;
          return {
            sessions: state.sessions.map((s) =>
              s.id === sessionId ? { ...s, lifecycle: "ended" as const } : s,
            ),
            tabs: remainingTabs,
            detachedRuntime: restDetached,
            activeTabId: nextActive,
            activeSessionId:
              state.activeSessionId === sessionId
                ? (remainingTabs.find((t) => t.id === nextActive)?.sessionId ?? null)
                : state.activeSessionId,
          };
        });
      },

      renameSession: (sessionId, title) => {
        set((state) => ({
          sessions: updateSessionById(state.sessions, sessionId, (s) => ({ ...s, title })),
          tabs: state.tabs.map((tab) =>
            tab.sessionId === sessionId ? { ...tab, title } : tab,
          ),
        }));
      },

      touchSession: (sessionId, at = Date.now()) => {
        set((state) => ({
          sessions: updateSessionById(state.sessions, sessionId, (s) => ({
            ...s,
            lastActiveAt: Math.max(s.lastActiveAt, at),
          })),
        }));
      },

      addTab: (tab) => {
        const sessionId = tab.sessionId ?? tab.id;
        const state = get();
        let sessions = state.sessions;
        if (!sessions.some((s) => s.id === sessionId)) {
          sessions = [
            ...sessions,
            createSessionEntity(tab.title, tab.session, sessionId),
          ];
        }
        const runtime = state.detachedRuntime[sessionId];
        const newTab: TerminalTab = {
          ...tab,
          id: tab.id,
          sessionId,
          backendSessionId: runtime?.backendSessionId ?? null,
          status: runtime?.status ?? "connecting",
          terminal: null,
          createdAt: Date.now(),
        };
        const { [sessionId]: _removed, ...restDetached } = state.detachedRuntime;
        const becomesActive = !tab.workspaceOnly;
        set({
          sessions: updateSessionById(sessions, sessionId, (s) => ({
            ...s,
            lifecycle: becomesActive ? "active" : s.lifecycle,
          })),
          tabs: [...state.tabs.filter((t) => t.sessionId !== sessionId), newTab],
          detachedRuntime: restDetached,
          activeTabId: tab.workspaceOnly ? state.activeTabId : (state.activeTabId ?? newTab.id),
          activeSessionId: tab.workspaceOnly ? state.activeSessionId : sessionId,
        });
        return newTab.id;
      },

      removeTab: (tabId) => {
        get().closeTabOnly(tabId);
      },

      setActiveTab: (tabId) => {
        const tab = get().tabs.find((t) => t.id === tabId || t.sessionId === tabId);
        if (!tab) {
          set({ activeTabId: tabId, activeSessionId: null });
          return;
        }
        set({
          activeTabId: tab.id,
          activeSessionId: tab.sessionId,
        });
      },

      setActiveSession: (sessionId) => {
        get().openSessionTab(sessionId);
      },

      setTerminal: (tabId, terminal) =>
        set((state) => ({ tabs: updateTabById(state.tabs, tabId, (tab) => ({ ...tab, terminal })) })),

      setStatus: (sessionId, status) =>
        set((state) => {
          const tabs = updateTabById(state.tabs, sessionId, (tab) =>
            tab.sessionId === sessionId || tab.id === sessionId ? { ...tab, status } : tab,
          );
          const pane = state.embeddedPanes[sessionId];
          const detached = state.detachedRuntime[sessionId];
          if (!pane && !detached && tabs === state.tabs) return { tabs };
          const nextDetached = detached
            ? { ...state.detachedRuntime, [sessionId]: { ...detached, status } }
            : state.detachedRuntime;
          if (!pane) return { tabs, detachedRuntime: nextDetached };
          return {
            tabs,
            detachedRuntime: nextDetached,
            embeddedPanes: {
              ...state.embeddedPanes,
              [sessionId]: { ...pane, status },
            },
          };
        }),

      setBackendSessionId: (sessionId, backendSessionId) =>
        set((state) => {
          const tabs = updateTabById(state.tabs, sessionId, (tab) =>
            tab.sessionId === sessionId || tab.id === sessionId
              ? { ...tab, backendSessionId }
              : tab,
          );
          const pane = state.embeddedPanes[sessionId];
          const detached = state.detachedRuntime[sessionId];
          const nextDetached = detached
            ? { ...state.detachedRuntime, [sessionId]: { ...detached, backendSessionId } }
            : state.detachedRuntime;
          if (!pane) return { tabs, detachedRuntime: nextDetached };
          return {
            tabs,
            detachedRuntime: nextDetached,
            embeddedPanes: {
              ...state.embeddedPanes,
              [sessionId]: { ...pane, backendSessionId },
            },
          };
        }),

      setSessionCwd: (sessionId, cwd) =>
        set((state) => {
          const sessions = updateSessionById(state.sessions, sessionId, (s) => ({
            ...s,
            session: { ...s.session, cwd },
          }));
          const tabs = updateTabById(state.tabs, sessionId, (tab) =>
            tab.sessionId === sessionId || tab.id === sessionId
              ? { ...tab, session: { ...tab.session, cwd } }
              : tab,
          );
          const pane = state.embeddedPanes[sessionId];
          if (!pane) return { tabs, sessions };
          return {
            tabs,
            sessions,
            embeddedPanes: {
              ...state.embeddedPanes,
              [sessionId]: { ...pane, cwd },
            },
          };
        }),

      setTabResource: (tabId, session) =>
        set((state) => ({
          tabs: updateTabById(state.tabs, tabId, (tab) => ({
            ...tab,
            session,
            terminal: null,
            backendSessionId: null,
            status: "connecting",
          })),
          sessions: updateSessionById(
            state.sessions,
            state.tabs.find((t) => t.id === tabId)?.sessionId ?? tabId,
            (s) => ({ ...s, session }),
          ),
        })),

      renameTab: (tabId, title) => {
        const tab = get().tabs.find((t) => t.id === tabId);
        if (tab?.sessionId) get().renameSession(tab.sessionId, title);
        else {
          set((state) => ({
            tabs: updateTabById(state.tabs, tabId, (t) => ({ ...t, title })),
          }));
        }
      },

      setTabWorkspaceOnly: (tabId, workspaceOnly) => {
        set((state) => ({
          tabs: updateTabById(state.tabs, tabId, (tab) => ({ ...tab, workspaceOnly })),
        }));
      },

      upsertEmbeddedPane: (pane) => {
        const id = pane.id;
        set((state) => {
          const existing = state.embeddedPanes[id];
          const next = existing
            ? {
                ...existing,
                ...pane,
                terminal: existing.terminal,
                status: existing.status,
                backendSessionId: existing.backendSessionId,
              }
            : createPane(pane);
          return {
            embeddedPanes: {
              ...state.embeddedPanes,
              [id]: next,
            },
          };
        });
        return id;
      },

      removeEmbeddedPane: (paneId) =>
        set((state) => {
          const { [paneId]: _removed, ...rest } = state.embeddedPanes;
          return { embeddedPanes: rest };
        }),

      findTabByResourceId: (resourceId, type) =>
        get().tabs.find(
          (tab) =>
            tab.session.resourceId === resourceId &&
            (type ? tab.session.type === type : true) &&
            !tab.workspaceOnly,
        ),

      openOrFocusSshTab: (hostId, title) => {
        const existing = get().tabs.find(
          (t) => t.session.resourceId === hostId && t.session.type === "remote" && !t.workspaceOnly,
        );
        if (existing) {
          get().setActiveTab(existing.id);
          return existing.id;
        }
        const suspended = get().sessions.find(
          (s) =>
            s.session.resourceId === hostId &&
            s.session.type === "remote" &&
            s.lifecycle === "suspended",
        );
        if (suspended) return get().openSessionTab(suspended.id);
        return get().addSshTerminalTab(hostId, title);
      },

      openOrFocusLocalTab: (title = "本地终端") => {
        const existing = get().tabs.find(
          (t) => t.session.resourceId === "local-terminal" && !t.workspaceOnly,
        );
        if (existing) {
          get().setActiveTab(existing.id);
          return existing.id;
        }
        const suspended = get().sessions.find(
          (s) => s.session.resourceId === "local-terminal" && s.lifecycle === "suspended",
        );
        if (suspended) return get().openSessionTab(suspended.id);
        return get().addLocalTerminalTab(title);
      },

      addLocalTerminalTab: (title = "本地终端", workspaceId?: string) => {
        const sessionId = get().createSession(
          title,
          defaultSessionInfo("local-terminal", "local"),
        );
        return get().addTab({
          id: sessionId,
          sessionId,
          title,
          workspaceId,
          session: defaultSessionInfo("local-terminal", "local"),
        });
      },

      addSshTerminalTab: (hostId, title, workspaceId?: string) => {
        const sessionId = get().createSession(title, defaultSessionInfo(hostId, "remote"));
        return get().addTab({
          id: sessionId,
          sessionId,
          title,
          workspaceId,
          session: defaultSessionInfo(hostId, "remote"),
        });
      },
    }),
    {
      name: TABS_STORAGE_KEY,
      version: TABS_STORAGE_VERSION,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        sessions: state.sessions
          .filter((s) => s.lifecycle !== "ended")
          .map((s) => ({
            id: s.id,
            title: s.title,
            session: s.session,
            createdAt: s.createdAt,
            lastActiveAt: s.lastActiveAt,
            lifecycle: s.lifecycle,
          })),
        tabs: state.tabs
          .filter((tab) => !tab.workspaceOnly)
          .map((tab) => ({
            id: tab.id,
            sessionId: tab.sessionId,
            title: tab.title,
            session: tab.session,
            createdAt: tab.createdAt,
          })),
        activeTabId: state.activeTabId,
        activeSessionId: state.activeSessionId,
      }),
      migrate: (persistedState, version) => {
        const persisted = persistedState as Record<string, unknown> | undefined;
        if (!persisted) return persistedState as TerminalState;

        if (version < 3) {
          const legacyTabs = (persisted.tabs as Array<Record<string, unknown>>) ?? [];
          const migrated = migrateLegacyTabsToSessions(legacyTabs);
          const activeTabId =
            typeof persisted.activeTabId === "string" ? persisted.activeTabId : migrated.activeTabId;
          const sessions = migrated.sessions;
          const openIds = new Set(migrated.openSessionIds);
          const tabs = sessions
            .filter((s) => openIds.has(s.id))
            .map((s) => tabFromSession(s));
          syncSessionCounterFromIds(sessions);
          syncTabCounterFromTabs(tabs);
          return {
            ...persisted,
            sessions,
            tabs,
            activeTabId:
              activeTabId && tabs.some((t) => t.id === activeTabId)
                ? activeTabId
                : tabs[0]?.id ?? null,
            activeSessionId:
              activeTabId && tabs.some((t) => t.id === activeTabId)
                ? activeTabId
                : tabs[0]?.sessionId ?? null,
            detachedRuntime: {},
          } as unknown as TerminalState;
        }
        return persistedState as TerminalState;
      },
      merge: (persistedState, currentState) => {
        const persisted = persistedState as
          | {
              sessions?: Array<Record<string, unknown>>;
              tabs?: Array<Record<string, unknown>>;
              activeTabId?: string | null;
              activeSessionId?: string | null;
            }
          | undefined;
        if (!persisted) return currentState;

        const sessions = (persisted.sessions ?? [])
          .map((item) => normalizePersistedSession(item))
          .filter((item): item is TerminalSession => item !== null);

        const tabs = (persisted.tabs ?? [])
          .map((item) => normalizeLegacyPersistedTab(item))
          .filter((item): item is TerminalTab => item !== null)
          .map((tab) => ({
            ...tab,
            backendSessionId: null,
            status: "connecting" as const,
            terminal: null,
          }));

        syncSessionCounterFromIds(sessions);
        syncTabCounterFromTabs(tabs);

        const activeTabId =
          typeof persisted.activeTabId === "string" &&
          tabs.some((t) => t.id === persisted.activeTabId)
            ? persisted.activeTabId
            : tabs[0]?.id ?? null;

        const activeSessionId =
          typeof persisted.activeSessionId === "string" &&
          sessions.some((s) => s.id === persisted.activeSessionId)
            ? persisted.activeSessionId
            : tabs.find((t) => t.id === activeTabId)?.sessionId ?? null;

        return {
          ...currentState,
          sessions,
          tabs,
          activeTabId,
          activeSessionId,
          detachedRuntime: {},
        };
      },
    },
  ),
);

export function getDetachedRuntime(sessionId: string): TerminalDetachedRuntime | undefined {
  return getRuntimeForSession(useTerminalStore.getState(), sessionId);
}
