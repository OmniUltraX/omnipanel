import type { TerminalSessionInfo, TerminalSessionType, TerminalTab } from "./terminalTypes";

export type TerminalSessionLifecycle = "active" | "suspended" | "ended";

/** 长期终端会话（与 TerminalSessionInfo 连接元数据区分） */
export interface TerminalSession {
  id: string;
  title: string;
  session: TerminalSessionInfo;
  createdAt: number;
  /** 最后一次命令或终端输出的时间（与 tab 激活无关） */
  lastActiveAt: number;
  lifecycle: TerminalSessionLifecycle;
}

export interface TerminalDetachedRuntime {
  backendSessionId: string | null;
  status: TerminalTab["status"];
}

let sessionCounter = 0;

export function syncSessionCounterFromIds(sessions: Array<{ id: string }>): void {
  let max = 0;
  for (const item of sessions) {
    const match = /^tsess-(\d+)$/.exec(item.id);
    if (match) max = Math.max(max, Number(match[1]));
    const legacy = /^tab-(\d+)$/.exec(item.id);
    if (legacy) max = Math.max(max, Number(legacy[1]));
  }
  sessionCounter = max;
}

export function createTerminalSessionId(): string {
  sessionCounter += 1;
  return `tsess-${sessionCounter}`;
}

export function defaultSessionInfo(
  resourceId: string,
  type: TerminalSessionType,
): TerminalSessionInfo {
  if (type === "local") {
    return {
      type: "local",
      resourceId,
      shellLabel: "PowerShell",
      cwd: "~/workspace",
      purpose: "Local Workspace",
      commandPack: [],
    };
  }
  return {
    type: "remote",
    resourceId,
    shellLabel: "SSH",
    cwd: "~/",
    purpose: "SSH Workbench",
    commandPack: [],
  };
}

export function createSessionEntity(
  title: string,
  session: TerminalSessionInfo,
  id = createTerminalSessionId(),
): TerminalSession {
  const now = Date.now();
  return {
    id,
    title,
    session,
    createdAt: now,
    lastActiveAt: 0,
    lifecycle: "suspended",
  };
}

export function tabFromSession(
  entity: TerminalSession,
  runtime?: TerminalDetachedRuntime,
): TerminalTab {
  return {
    id: entity.id,
    sessionId: entity.id,
    title: entity.title,
    session: { ...entity.session },
    backendSessionId: runtime?.backendSessionId ?? null,
    status: runtime?.status ?? "connecting",
    terminal: null,
    createdAt: entity.createdAt,
  };
}

export function normalizePersistedSession(raw: unknown): TerminalSession | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== "string" || typeof item.title !== "string") return null;
  const sessionSource = item.session as Record<string, unknown> | undefined;
  if (!sessionSource || typeof sessionSource.resourceId !== "string") return null;
  const type: TerminalSessionType = sessionSource.type === "remote" ? "remote" : "local";
  const session: TerminalSessionInfo = {
    type,
    resourceId: sessionSource.resourceId,
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
  const lifecycle =
    item.lifecycle === "active" || item.lifecycle === "ended" ? item.lifecycle : "suspended";
  const createdAt = typeof item.createdAt === "number" ? item.createdAt : Date.now();
  const legacyActive =
    typeof item.lastActiveAt === "number"
      ? item.lastActiveAt
      : typeof item.lastActivatedAt === "number"
        ? item.lastActivatedAt
        : 0;
  return {
    id: item.id,
    title: item.title,
    session,
    createdAt,
    lastActiveAt: legacyActive,
    lifecycle,
  };
}

export function migrateLegacyTabsToSessions(
  legacyTabs: Array<Record<string, unknown>>,
): { sessions: TerminalSession[]; openSessionIds: string[]; activeTabId: string | null } {
  const sessions: TerminalSession[] = [];
  const openSessionIds: string[] = [];
  let activeTabId: string | null = null;

  for (const raw of legacyTabs) {
    if (typeof raw.id !== "string" || typeof raw.title !== "string") continue;
    const sessionSource =
      (raw.session as Record<string, unknown> | undefined) ??
      (Array.isArray(raw.panes) ? (raw.panes[0] as Record<string, unknown>) : undefined);
    if (!sessionSource) continue;
    const type: TerminalSessionType = sessionSource.type === "remote" ? "remote" : "local";
    const resourceId =
      typeof sessionSource.resourceId === "string" ? sessionSource.resourceId : "local-terminal";
    const entity = createSessionEntity(raw.title, {
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
    }, raw.id);
    entity.lifecycle = "suspended";
    sessions.push(entity);
    openSessionIds.push(entity.id);
  }

  syncSessionCounterFromIds(sessions);
  return { sessions, openSessionIds, activeTabId };
}
