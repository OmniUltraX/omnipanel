import { useSyncExternalStore } from "react";
import type { DockableTab } from "./dockableTab";
import type { DockTabPageType } from "./dockableTab";
import { logDockTabFile } from "./dockTabFileDebug";

export interface DockTabLiveMeta {
  type?: DockTabPageType;
  dirty?: boolean;
  saved?: boolean;
  rev: number;
}

const metaByTabId = new Map<string, DockTabLiveMeta>();
const listeners = new Set<() => void>();

/** 无元数据 Tab 的稳定快照；getSnapshot 必须返回可缓存的同一引用 */
const EMPTY_TAB_META: DockTabLiveMeta = Object.freeze({ rev: 0 });

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(tabId: string): DockTabLiveMeta {
  return metaByTabId.get(tabId) ?? EMPTY_TAB_META;
}

/** 将业务 tabs 的 file 元数据同步到 Tab 头可订阅的快照（不依赖 dockview params 重绘时机）。 */
export function publishDockTabMeta(tabs: DockableTab[]): void {
  const nextIds = new Set(tabs.map((tab) => tab.id));
  let changed = false;

  for (const tab of tabs) {
    const prev = metaByTabId.get(tab.id);
    if (
      prev &&
      prev.type === tab.type &&
      prev.dirty === tab.dirty &&
      prev.saved === tab.saved
    ) {
      continue;
    }
    metaByTabId.set(tab.id, {
      type: tab.type,
      dirty: tab.dirty,
      saved: tab.saved,
      rev: (prev?.rev ?? 0) + 1,
    });
    if (tab.type === "file") {
      logDockTabFile("publish", {
        tabId: tab.id,
        label: tab.label,
        prev: prev ?? null,
        next: metaByTabId.get(tab.id),
      });
    }
    changed = true;
  }

  for (const id of metaByTabId.keys()) {
    if (!nextIds.has(id)) {
      metaByTabId.delete(id);
      changed = true;
    }
  }

  if (changed) {
    emit();
  }
}

export function useDockTabLiveMeta(tabId: string): DockTabLiveMeta {
  return useSyncExternalStore(
    subscribe,
    () => getSnapshot(tabId),
    () => getSnapshot(tabId),
  );
}
