import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { Terminal } from "@xterm/xterm";

let tabCounter = 0;

/** 从已持久化的 tab id 恢复计数器，避免刷新后重复生成 tab-1 */
function syncTabCounterFromTabs(tabs: Array<{ id: string }>): void {
  let max = 0;
  for (const tab of tabs) {
    const match = /^tab-(\d+)$/.exec(tab.id);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  tabCounter = max;
}

export function createTerminalTabId() {
  tabCounter += 1;
  return `tab-${tabCounter}`;
}

export type TerminalSessionType = "local" | "remote";

/**
 * 终端会话连接字段（本地 / SSH 通用）。
 * 每个 TerminalTab 直接持有一份；与 rc-dock 的 1 tab = 1 终端 会话模型对齐。
 */
export type TerminalSessionInfo = {
  type: TerminalSessionType;
  resourceId: string;
  shellLabel: string;
  cwd: string;
  purpose: string;
  commandPack: string[];
};

/**
 * 终端 Tab（= 一个 rc-dock tab = 一条 PTY/SSH 会话）。
 * 历史数据模型中 Tab 内嵌 `panes[]`，实践中始终只有一个 pane，造成与
 * rc-dock 概念重叠、UI 难以拆分多面板。本次重构把会话字段直接平铺到 Tab。
 */
export interface TerminalTab {
  id: string;
  title: string;
  session: TerminalSessionInfo;
  workspaceId?: string;
  /** 仅由底部工作区 payload 使用，不在终端模块 Dock 中展示 */
  workspaceOnly?: boolean;
  backendSessionId: string | null;
  status: "connecting" | "connected" | "disconnected";
  terminal: Terminal | null;
  createdAt: number;
}

/** SSH 模块内嵌终端窗格（与 `TerminalTab` 并存，允许多 pane）。 */
export interface TerminalPane {
  id: string;
  backendSessionId: string | null;
  title: string;
  type: TerminalSessionType;
  resourceId: string;
  shellLabel: string;
  cwd: string;
  purpose: string;
  commandPack: string[];
  terminal: Terminal | null;
  status: "connecting" | "connected" | "disconnected";
}

export type TerminalTabInput = Omit<
  TerminalTab,
  "backendSessionId" | "status" | "terminal" | "createdAt"
>;

export type { TerminalSessionInfo as TerminalTabSession };

interface TerminalState {
  tabs: TerminalTab[];
  activeTabId: string | null;
  /** SSH 等模块内嵌终端（不占用顶部终端 Tab） */
  embeddedPanes: Record<string, TerminalPane>;

  addTab: (tab: TerminalTabInput) => string;
  removeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  setTerminal: (tabId: string, terminal: Terminal) => void;
  setStatus: (tabId: string, status: TerminalTab["status"]) => void;
  setBackendSessionId: (tabId: string, backendSessionId: string | null) => void;
  /** 更新会话当前工作目录（shell integration / 远程 cwd 钩子） */
  setSessionCwd: (sessionId: string, cwd: string) => void;
  /**
   * 切换 Tab 目标服务器（调用方需先 dispose 旧后端会话）。
   * Tab 的 id 保持不变；旧后端会话 dispose 后 store 内部的 id 计数器维持。
   */
  setTabResource: (tabId: string, session: TerminalSessionInfo) => void;
  /** 调整 Tab 标题（如资源改名） */
  renameTab: (tabId: string, title: string) => void;
  /** 设置 tab 是否仅在工作区中显示 */
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
  addLocalTerminalTab: (title?: string) => string;
  addSshTerminalTab: (hostId: string, title: string) => string;
}

/** 在 Tab 中按 id 查找并应用更新（找不到则原样返回） */
function updateTabById(
  tabs: TerminalTab[],
  tabId: string,
  updater: (tab: TerminalTab) => TerminalTab,
): TerminalTab[] {
  return tabs.map((tab) => (tab.id === tabId ? updater(tab) : tab));
}

/** 在所有终端位置（Tab + embeddedPane）中查找（供 useTerminal 使用） */
export function findTerminalSession(
  id: string,
): { kind: "tab"; tab: TerminalTab } | { kind: "pane"; pane: TerminalPane } | undefined {
  const state = useTerminalStore.getState();
  const tab = state.tabs.find((item) => item.id === id);
  if (tab) return { kind: "tab", tab };
  const pane = state.embeddedPanes[id];
  if (pane) return { kind: "pane", pane };
  return undefined;
}

/** 向后兼容旧调用方：仅返回 pane 形态（embedded pane 或 tab 转 p 形态） */
export function findTerminalPane(id: string): TerminalPane | undefined {
  const session = findTerminalSession(id);
  if (!session) return undefined;
  if (session.kind === "pane") return session.pane;
  const tab = session.tab;
  return {
    id: tab.id,
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

/** SSH 模块内嵌终端工作区 id（首个窗格可能与此 id 相同） */
export function sshEmbeddedWorkspaceId(resourceId: string) {
  return `${SSH_EMBEDDED_PANE_PREFIX}${resourceId}`;
}

/** @deprecated 请使用 sshEmbeddedWorkspaceId */
export function sshEmbeddedPaneId(resourceId: string) {
  return sshEmbeddedWorkspaceId(resourceId);
}

function normalizePersistedTab(tab: unknown): TerminalTab | null {
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
  return {
    id: raw.id,
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
const TABS_STORAGE_VERSION = 2;

export const useTerminalStore = create<TerminalState>()(
  persist(
    (set, get) => ({
      tabs: [],
      activeTabId: null,
      embeddedPanes: {},

      addTab: (tab) => {
        const newTab: TerminalTab = {
          ...tab,
          backendSessionId: null,
          status: "connecting",
          terminal: null,
          createdAt: Date.now(),
        };
        set((state) => ({
          tabs: [...state.tabs, newTab],
          activeTabId: tab.workspaceOnly
            ? state.activeTabId
            : (state.activeTabId ?? newTab.id),
        }));
        return newTab.id;
      },

      removeTab: (tabId) =>
        set((state) => {
          const remaining = state.tabs.filter((tab) => tab.id !== tabId);
          const nextActiveTabId =
            state.activeTabId === tabId
              ? remaining.length > 0
                ? remaining[Math.max(remaining.length - 1, 0)].id
                : null
              : state.activeTabId;
          return { tabs: remaining, activeTabId: nextActiveTabId };
        }),

      setActiveTab: (tabId) => set({ activeTabId: tabId }),

      setTerminal: (tabId, terminal) =>
        set((state) => ({ tabs: updateTabById(state.tabs, tabId, (tab) => ({ ...tab, terminal })) })),

      setStatus: (tabId, status) =>
        set((state) => ({ tabs: updateTabById(state.tabs, tabId, (tab) => ({ ...tab, status })) })),

      setBackendSessionId: (tabId, backendSessionId) =>
        set((state) => ({
          tabs: updateTabById(state.tabs, tabId, (tab) => ({ ...tab, backendSessionId })),
        })),

      setSessionCwd: (sessionId, cwd) =>
        set((state) => {
          const tabs = updateTabById(state.tabs, sessionId, (tab) => ({
            ...tab,
            session: { ...tab.session, cwd },
          }));
          const pane = state.embeddedPanes[sessionId];
          if (!pane) return { tabs };
          return {
            tabs,
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
        })),

      renameTab: (tabId, title) => {
        set((state) => ({
          tabs: updateTabById(state.tabs, tabId, (tab) => ({ ...tab, title })),
        }));
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
            tab.session.resourceId === resourceId && (type ? tab.session.type === type : true) && !tab.workspaceOnly,
        ),

      openOrFocusSshTab: (hostId, title) => {
        const existing = get().findTabByResourceId(hostId, "remote");
        if (existing) {
          set({ activeTabId: existing.id });
          return existing.id;
        }
        return get().addSshTerminalTab(hostId, title);
      },

      openOrFocusLocalTab: (title = "本地终端") => {
        const existing = get().findTabByResourceId("local-terminal", "local");
        if (existing) {
          set({ activeTabId: existing.id });
          return existing.id;
        }
        return get().addLocalTerminalTab(title);
      },

      addLocalTerminalTab: (title = "本地终端", workspaceId?: string) => {
        return get().addTab({
          id: createTerminalTabId(),
          title,
          workspaceId,
          session: {
            type: "local",
            resourceId: "local-terminal",
            shellLabel: "PowerShell",
            cwd: "~/workspace",
            purpose: "Local Workspace",
            commandPack: [],
          },
        });
      },

      addSshTerminalTab: (hostId, title, workspaceId?: string) => {
        return get().addTab({
          id: createTerminalTabId(),
          title,
          workspaceId,
          session: {
            type: "remote",
            resourceId: hostId,
            shellLabel: "SSH",
            cwd: "~/",
            purpose: "SSH Workbench",
            commandPack: [],
          },
        });
      },
    }),
    {
      name: TABS_STORAGE_KEY,
      version: TABS_STORAGE_VERSION,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        tabs: state.tabs
          .filter((tab) => !tab.workspaceOnly)
          .map((tab) => ({
            id: tab.id,
            title: tab.title,
            session: tab.session,
            createdAt: tab.createdAt,
          })),
        activeTabId: state.activeTabId,
      }),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as
          | { tabs?: Array<Record<string, unknown>>; activeTabId?: string | null }
          | undefined;
        if (!persisted) return currentState;
        const tabs = (persisted.tabs ?? [])
          .map((item) => normalizePersistedTab(item))
          .filter((item): item is TerminalTab => item !== null);
        syncTabCounterFromTabs(tabs);
        return {
          ...currentState,
          tabs,
          activeTabId:
            typeof persisted.activeTabId === "string" &&
            tabs.some((t) => t.id === persisted.activeTabId)
              ? persisted.activeTabId
              : tabs[0]?.id ?? null,
        };
      },
    },
  ),
);
