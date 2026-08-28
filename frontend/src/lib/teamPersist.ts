/**
 * 业务 persist 按当前同步团队分桶：`{name}::team:{scope}`。
 * 偏好类 store（settings / auth / 模型）不在名单内，保持本机全局。
 */

const TEAM_SCOPED_NAMES = new Set<string>([
  "omnipanel-workspace-store",
  "omnipanel-workspace-tabs",
  "omnipanel-workspace-membership",
  "omnipanel.workspace-bottom-dock.v3",
  "omnipanel.dashboard.home-tab",
  "omnipanel-ai-store",
  "omnipanel-ai-loops.v1",
  "omnipanel-ai-orchestration.v1",
  "omnipanel-pending-follow-intents.v1",
  "omnipanel-knowledge-store",
  "omnipanel-knowledge-workspace",
  "omnipanel-client-sync-tombstones.v1",
  "omnipanel-protocol-workspace.v1",
  "omnipanel-protocol-lab-entries.v1",
  "omnipanel-protocol-http-dock.v1",
  "omnipanel-protocol-http-layout.v1",
  "omnipanel-db-groups",
  "omnipanel-db-scratch-query",
  "omnipanel-db-sql-files",
  "omnipanel-db-schema-connection-layout.v1",
  "omnipanel.dbDockLayout.v6",
  "omnipanel-ssh-panel-dock.v1",
  "omnipanel.sshDockLayout.v1",
  "omnipanel.sshSidebarTree.v1",
  "omnipanel.ssh.manualGroups.v1",
  "omnipanel-ssh-workspace-nav",
  "omnipanel-ssh-tree-expanded.v1",
  "omnipanel-docker-panel-dock.v1",
  "omnipanel.dockerDockLayout.v1",
  "omnipanel.dockerSidebarTree.v1",
  "omnipanel.docker.composeFiles.v1",
  "omnipanel-server-panel-cache.v1",
  "omnipanel-server-panel-dock.v1",
  "omnipanel.serverDockLayout.v1",
  "omnipanel-server-tabs",
  "omnipanel-server-groups",
  "omnipanel.filesWorkspace.v1",
  "omnipanel.filesFavorites.v1",
  "omnipanel.terminalTabs.v2",
  "omnipanel-tmux-pane-session-index.v1",
  "omnipanel.terminalDockLayout.v1",
  "omnipanel-terminal-shell-history.v1",
  "omnipanel-workflow-store",
  "omnipanel-bg-task-history.v1",
  "omnipanel-team-sync-exclusions.v1",
  "omnipanel.sqlQueryHistory.v1",
  "omnipanel-table-details-cache.v1",
  "omnipanel.db.table-query.history.v1",
  "omnipanel-bottom-panel",
  "omnipanel-module-tabs.v1",
]);

function readBootTeamScope(): string {
  try {
    const raw = localStorage.getItem("omnipanel-current-sync-team.v1");
    if (!raw) return "local";
    const parsed = JSON.parse(raw) as { state?: { teamId?: number | null } };
    const id = parsed.state?.teamId;
    if (typeof id === "number" && Number.isFinite(id) && id > 0) {
      return String(id);
    }
  } catch {
    // ignore
  }
  return "local";
}

let teamScope = readBootTeamScope();

/** persist 桶切换后派发，供非 zustand 的 localStorage 记忆（如 SSH 树展开）重读。 */
export const TEAM_PERSIST_SCOPE_CHANGED_EVENT = "omnipanel:team-persist-scope-changed";

export function getTeamPersistScope(): string {
  return teamScope;
}

export function setTeamPersistScope(scope: string): void {
  const next = (scope.trim() || "local").replace(/[^A-Za-z0-9_-]/g, "");
  const normalized = next || "local";
  if (normalized === teamScope) return;
  teamScope = normalized;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(TEAM_PERSIST_SCOPE_CHANGED_EVENT));
  }
}

export function isTeamScopedPersistName(name: string): boolean {
  return TEAM_SCOPED_NAMES.has(name);
}

/** 把 zustand persist `name` 映射到当前团队桶；非业务 key 原样返回。 */
export function teamStorageKey(name: string): string {
  if (name.includes("::team:")) return name;
  if (!isTeamScopedPersistName(name)) return name;
  return `${name}::team:${teamScope}`;
}

type StorageLike = {
  getItem: (name: string) => string | null | Promise<string | null>;
  setItem: (name: string, value: string) => void | Promise<void>;
  removeItem: (name: string) => void | Promise<void>;
};

function takeLegacy<T>(
  inner: StorageLike,
  name: string,
  keyed: string,
  hit: T,
): T | Promise<T> {
  if (hit != null) return hit;
  if (keyed === name) return hit;
  const legacy = inner.getItem(name);
  const adopt = (value: string | null): T => {
    if (value == null) return null as T;
    void inner.setItem(keyed, value);
    // 迁走无后缀 key，避免切到空团队时把旧数据再播种进去
    void inner.removeItem(name);
    return value as T;
  };
  if (legacy instanceof Promise) {
    return legacy.then(adopt) as Promise<T>;
  }
  return adopt(legacy);
}

/**
 * 包装 localStorage / IndexedDB adapter：读写走团队后缀，首次从无后缀 key 迁一次。
 * localStorage 的 getItem 保持同步，避免启动 hydration 变成异步。
 */
export function wrapTeamScopedStorage<T extends StorageLike>(inner: T): T {
  const getItem = (name: string): string | null | Promise<string | null> => {
    const keyed = teamStorageKey(name);
    const hit = inner.getItem(keyed);
    if (hit instanceof Promise) {
      return hit.then((v) => takeLegacy(inner, name, keyed, v));
    }
    return takeLegacy(inner, name, keyed, hit);
  };
  const setItem = (name: string, value: string): void | Promise<void> =>
    inner.setItem(teamStorageKey(name), value);
  const removeItem = (name: string): void | Promise<void> =>
    inner.removeItem(teamStorageKey(name));
  return { ...inner, getItem, setItem, removeItem };
}

/** 非 zustand 的业务 localStorage：按当前团队桶读写，并一次性迁无后缀旧 key。 */
export function readTeamLocalStorage(name: string): string | null {
  const keyed = teamStorageKey(name);
  try {
    const hit = localStorage.getItem(keyed);
    if (hit != null) return hit;
    if (keyed === name) return null;
    const legacy = localStorage.getItem(name);
    if (legacy != null) {
      localStorage.setItem(keyed, legacy);
      localStorage.removeItem(name);
      return legacy;
    }
  } catch {
    // ignore
  }
  return null;
}

export function writeTeamLocalStorage(name: string, value: string): void {
  try {
    localStorage.setItem(teamStorageKey(name), value);
  } catch {
    // ignore
  }
}
