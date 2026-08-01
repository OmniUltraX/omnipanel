import type { LocalShellSpec, TerminalSessionInfo, TerminalSessionType, TerminalTab } from "./terminalTypes";

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

/** 本地终端曾误用 ~/workspace 占位，与 PowerShell 实际起始目录不一致 */
function normalizePersistedSessionCwd(cwd: string, type: TerminalSessionType): string {
  if (type === "local" && (cwd === "~/workspace" || cwd === "~/workspace/")) {
    return "~";
  }
  return cwd;
}

const VALID_SHELL_KINDS = new Set<LocalShellKind>([
  "bash", "zsh", "powershell", "powershell5", "fish", "cmd", "wsl",
]);

/** 从持久化数据中安全恢复 shellSpec，非法值返回 null */
export function normalizePersistedShellSpec(raw: unknown): LocalShellSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.kind !== "string" || !VALID_SHELL_KINDS.has(obj.kind as LocalShellKind)) {
    return null;
  }
  return {
    kind: obj.kind as LocalShellKind,
    path: typeof obj.path === "string" ? obj.path : null,
    wslDistro: typeof obj.wslDistro === "string" ? obj.wslDistro : null,
  };
}

export function createTerminalSessionId(): string {
  sessionCounter += 1;
  return `tsess-${sessionCounter}`;
}

/** 根据 shellSpec 推导 shellLabel 显示名 */
function shellLabelFromSpec(spec: LocalShellSpec | null | undefined): string {
  if (!spec) return "Shell";
  switch (spec.kind) {
    case "powershell":
      return "PowerShell 7";
    case "powershell5":
      return "Windows PowerShell 5";
    case "cmd":
      return "CMD";
    case "wsl":
      return spec.wslDistro ? `${spec.wslDistro} (WSL)` : "WSL";
    case "bash":
      return "Bash";
    case "zsh":
      return "Zsh";
    case "fish":
      return "Fish";
    default:
      return "Shell";
  }
}

export function defaultSessionInfo(
  resourceId: string,
  type: TerminalSessionType,
  shellSpec?: LocalShellSpec | null,
): TerminalSessionInfo {
  if (type === "local") {
    return {
      type: "local",
      resourceId,
      shellLabel: shellSpec ? shellLabelFromSpec(shellSpec) : "PowerShell",
      cwd: "~",
      purpose: "Local Workspace",
      commandPack: [],
      shellSpec: shellSpec ?? null,
    };
  }
  return {
    type: "remote",
    resourceId,
    shellLabel: "SSH",
    cwd: "~/",
    purpose: "SSH Workbench",
    commandPack: [],
    shellSpec: null,
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
    cwd: normalizePersistedSessionCwd(
      typeof sessionSource.cwd === "string" ? sessionSource.cwd : "~/",
      type,
    ),
    purpose:
      typeof sessionSource.purpose === "string"
        ? sessionSource.purpose
        : type === "remote"
          ? "SSH Workbench"
          : "Local Workspace",
    commandPack: Array.isArray(sessionSource.commandPack)
      ? (sessionSource.commandPack as unknown[]).filter((c): c is string => typeof c === "string")
      : [],
    shellSpec: normalizePersistedShellSpec(sessionSource.shellSpec),
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
      cwd: normalizePersistedSessionCwd(
      typeof sessionSource.cwd === "string" ? sessionSource.cwd : "~/",
      type,
    ),
      purpose:
        typeof sessionSource.purpose === "string"
          ? sessionSource.purpose
          : type === "remote"
            ? "SSH Workbench"
            : "Local Workspace",
      commandPack: Array.isArray(sessionSource.commandPack)
        ? (sessionSource.commandPack as unknown[]).filter((c): c is string => typeof c === "string")
        : [],
      shellSpec: normalizePersistedShellSpec(sessionSource.shellSpec),
    }, raw.id);
    entity.lifecycle = "suspended";
    sessions.push(entity);
    openSessionIds.push(entity.id);
  }

  syncSessionCounterFromIds(sessions);
  return { sessions, openSessionIds, activeTabId };
}
