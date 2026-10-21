import { listen } from "@tauri-apps/api/event";
import { RESOURCE_DEDUPE_APPLIED } from "../ipc/events";
import { notifyAssistantSnapshotSync } from "./assistantSnapshotSyncBridge";
import { notifyClientModuleSync } from "./clientModuleSyncBridge";
import type { WorkspaceTabSnapshot } from "../stores/workspaceTabStore";

export type IdRewrite = { from: string; to: string };

type Report = { rewrites?: IdRewrite[] };

type StoreLike = {
  getState: () => object;
  setState: (partial: object) => void;
};

const MIN_ID_LENGTH = 8;
const ID_TEXT = /^[A-Za-z0-9_.:-]+$/;

let unlisten: (() => void) | null = null;

export function compileRewrites(rewrites: IdRewrite[]): IdRewrite[] {
  const seen = new Set<string>();
  const pairs: IdRewrite[] = [];
  for (const item of rewrites) {
    const from = item.from?.trim() ?? "";
    const to = item.to?.trim() ?? "";
    if (from.length < MIN_ID_LENGTH || !to || from === to || seen.has(from)) continue;
    if (!ID_TEXT.test(from) || !ID_TEXT.test(to)) continue;
    seen.add(from);
    pairs.push({ from, to });
  }
  pairs.sort((a, b) => b.from.length - a.from.length);
  return pairs;
}

function isBoundary(ch: string | undefined): boolean {
  return ch === undefined || !/[A-Za-z0-9]/.test(ch);
}

/** 整段相等，或出现在 `c:` / `ssh-embedded-` 这类前缀后面。 */
export function rewriteString(value: string, pairs: IdRewrite[]): string {
  const exact = pairs.find((pair) => pair.from === value);
  if (exact) return exact.to;
  let out = value;
  for (const pair of pairs) {
    if (!out.includes(pair.from)) continue;
    let cursor = 0;
    let next = "";
    while (cursor < out.length) {
      const at = out.indexOf(pair.from, cursor);
      if (at < 0) {
        next += out.slice(cursor);
        break;
      }
      const before = at === 0 ? undefined : out[at - 1];
      const afterIndex = at + pair.from.length;
      const after = afterIndex >= out.length ? undefined : out[afterIndex];
      if (isBoundary(before) && isBoundary(after)) {
        next += out.slice(cursor, at) + pair.to;
        cursor = afterIndex;
      } else {
        next += out.slice(cursor, at + 1);
        cursor = at + 1;
      }
    }
    out = next;
  }
  return out;
}

function dedupeStrings(items: string[], pairs: IdRewrite[]): string[] {
  const rewritten = items.map((item) => rewriteString(item, pairs));
  const produced = new Set<string>();
  rewritten.forEach((next, index) => {
    if (next !== items[index]) produced.add(next);
  });
  const seen = new Set<string>();
  const out: string[] = [];
  for (const next of rewritten) {
    if (produced.has(next)) {
      if (seen.has(next)) continue;
      seen.add(next);
    }
    out.push(next);
  }
  return out;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function rewriteNode(value: unknown, pairs: IdRewrite[], changed: { hit: boolean }): unknown {
  if (typeof value === "string") {
    const next = rewriteString(value, pairs);
    if (next !== value) changed.hit = true;
    return next;
  }
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string")) {
      const next = dedupeStrings(value, pairs);
      const same = next.length === value.length && next.every((item, index) => item === value[index]);
      if (!same) changed.hit = true;
      return same ? value : next;
    }
    let hit = false;
    const next = value.map((item) => {
      const inner = { hit: false };
      const rewritten = rewriteNode(item, pairs, inner);
      if (inner.hit) hit = true;
      return rewritten;
    });
    if (hit) changed.hit = true;
    return hit ? next : value;
  }
  if (value && typeof value === "object") {
    if (!isPlainObject(value)) return value;
    let hit = false;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const nextKey = rewriteString(key, pairs);
      if (nextKey !== key) hit = true;
      if (typeof item === "function") {
        if (!Object.prototype.hasOwnProperty.call(out, nextKey) || key === nextKey) out[nextKey] = item;
        continue;
      }
      const inner = { hit: false };
      const nextValue = rewriteNode(item, pairs, inner);
      if (inner.hit) hit = true;
      if (Object.prototype.hasOwnProperty.call(out, nextKey)) {
        if (key === nextKey) out[nextKey] = nextValue;
        continue;
      }
      out[nextKey] = nextValue;
    }
    if (hit) changed.hit = true;
    return hit ? out : value;
  }
  return value;
}

/** 没改到的子树保持原引用，终端实例不会被拆开。 */
export function rewriteValue(value: unknown, pairs: IdRewrite[]): unknown {
  return rewriteNode(value, pairs, { hit: false });
}

function rewriteStore(store: StoreLike, pairs: IdRewrite[]) {
  const partial: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(store.getState())) {
    if (typeof value === "function") continue;
    const next = rewriteValue(value, pairs);
    if (next !== value) partial[key] = next;
  }
  if (Object.keys(partial).length > 0) store.setState(partial);
}

async function loadStores(): Promise<StoreLike[]> {
  const modules = await Promise.all([
    import("../stores/terminalStore"),
    import("../stores/workspaceStore"),
    import("../stores/workspaceTabStore"),
    import("../stores/dockerPanelDockStore"),
    import("../stores/dockerSidebarCacheStore"),
    import("../stores/dockerSidebarTreeStore"),
    import("../stores/sshSidebarTreeStore"),
    import("../stores/dbSchemaConnectionLayoutStore"),
    import("../stores/dbSqlFileStore"),
    import("../stores/dbWorkspaceSessionStore"),
    import("../stores/dbSyncTaskStore"),
    import("../stores/dbTreeChartFileStore"),
    import("../stores/serverPanelCacheStore"),
    import("../stores/serverPanelDockStore"),
    import("../stores/serverGroupStore"),
    import("../stores/protocolLabEntryStore"),
    import("../stores/protocolHttpDockStore"),
    import("../stores/protocolHttpLayoutStore"),
    import("../stores/cloudDockStore"),
    import("../stores/cloudInventoryStore"),
    import("../stores/moduleDockStore"),
    import("../stores/panelLayoutStore"),
    import("../stores/workspaceBottomDockStore"),
    import("../stores/knowledgeWorkspaceStore"),
  ]);
  const names = [
    "useTerminalStore",
    "useWorkspaceStore",
    "useWorkspaceTabStore",
    "useDockerPanelDockStore",
    "useDockerSidebarCacheStore",
    "useDockerSidebarTreeStore",
    "useSshSidebarTreeStore",
    "useDbSchemaConnectionLayoutStore",
    "useDbSqlFileStore",
    "useDbWorkspaceSessionStore",
    "useDbSyncTaskStore",
    "useDbTreeChartFileStore",
    "useServerPanelCacheStore",
    "useServerPanelDockStore",
    "useServerGroupStore",
    "useProtocolLabEntryStore",
    "useProtocolHttpDockStore",
    "useProtocolHttpLayoutStore",
    "useCloudDockStore",
    "useCloudInventoryStore",
    "useModuleDockStore",
    "usePanelLayoutStore",
    "useWorkspaceBottomDockStore",
    "useKnowledgeWorkspaceStore",
  ];
  return modules.map((mod, index) => (mod as unknown as Record<string, StoreLike>)[names[index]]);
}

function tabIdentity(tab: WorkspaceTabSnapshot): string | null {
  if (tab.module === "terminal") return `terminal:${tab.resourceId}:${tab.sessionType}`;
  if (tab.module === "docker") {
    return `docker:${tab.connectionId}:${tab.containerId}:${tab.subTab}`;
  }
  return null;
}

function collapseTabs(tabs: WorkspaceTabSnapshot[]): WorkspaceTabSnapshot[] {
  const seen = new Set<string>();
  const out: WorkspaceTabSnapshot[] = [];
  for (const tab of tabs) {
    const key = tabIdentity(tab);
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(tab);
  }
  return out;
}

async function collapseWorkspaceSnapshots() {
  const { useWorkspaceTabStore } = await import("../stores/workspaceTabStore");
  const tabsByWorkspace = useWorkspaceTabStore.getState().tabsByWorkspace;
  let changed = false;
  const next: Record<string, WorkspaceTabSnapshot[]> = {};
  for (const [workspaceId, tabs] of Object.entries(tabsByWorkspace)) {
    const collapsed = collapseTabs(tabs);
    next[workspaceId] = collapsed;
    if (collapsed.length !== tabs.length) changed = true;
  }
  if (changed) useWorkspaceTabStore.setState({ tabsByWorkspace: next });
}

async function refreshResourceLists() {
  const [{ useConnectionStore }, { useDbConnectionListStore }] = await Promise.all([
    import("../stores/connectionStore"),
    import("../stores/dbConnectionListStore"),
  ]);
  await Promise.all([
    useConnectionStore.getState().refresh().catch(() => undefined),
    useDbConnectionListStore.getState().refresh().catch(() => undefined),
  ]);
}

/** 宿主清理成功后，把打开中的会话改挂到保留项。不关闭正在跑的终端。 */
export async function applyResourceDedupeRewrites(rewrites: IdRewrite[]): Promise<void> {
  const pairs = compileRewrites(rewrites);
  if (pairs.length > 0) {
    const stores = await loadStores();
    for (const store of stores) rewriteStore(store, pairs);
    await collapseWorkspaceSnapshots();
  }
  await refreshResourceLists();
  notifyAssistantSnapshotSync();
  notifyClientModuleSync();
}

export async function initResourceDedupeListener(): Promise<void> {
  if (unlisten) return;
  try {
    unlisten = await listen<Report>(RESOURCE_DEDUPE_APPLIED, (event) => {
      void applyResourceDedupeRewrites(event.payload?.rewrites ?? []);
    });
  } catch {
    unlisten = null;
  }
}
