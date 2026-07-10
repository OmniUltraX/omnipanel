import { useSyncExternalStore } from "react";
import type { DockableTab } from "./dockableTab";
import type { DockTabPageType } from "./dockableTab";
import type { DockHeaderIconKind } from "./DockHeaderIcon";

export interface DockTabLiveMeta {
  type?: DockTabPageType;
  dirty?: boolean;
  saved?: boolean;
  preview?: boolean;
  icon?: DockHeaderIconKind;
  label?: string;
  tabBarHidden?: boolean;
  rev: number;
}

const metaByTabId = new Map<string, DockTabLiveMeta>();
const listeners = new Set<() => void>();

/** 无元数据 Tab 的稳定快照；getSnapshot 必须返回可缓存的同一引用 */
const EMPTY_TAB_META: DockTabLiveMeta = Object.freeze({ rev: 0 });

function sameOptionalFlag(a: boolean | undefined, b: boolean | undefined): boolean {
  return Boolean(a) === Boolean(b);
}

function tabMetaFingerprint(tabs: DockableTab[]): string {
  return tabs
    .map((tab) =>
      [
        tab.id,
        tab.label,
        tab.icon ?? "",
        tab.type ?? "",
        tab.dirty ? "1" : "0",
        tab.saved ? "1" : "0",
        tab.preview ? "1" : "0",
        tab.tabBarHidden ? "1" : "0",
      ].join("|"),
    )
    .join("\n");
}

let lastPublishedTabMetaFingerprint = "";

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

/** 将业务 tabs 元数据同步到 Tab 头可订阅的快照（不依赖 dockview params 重绘时机）。 */
export function publishDockTabMeta(tabs: DockableTab[]): void {
  const fingerprint = tabMetaFingerprint(tabs);
  if (fingerprint === lastPublishedTabMetaFingerprint) {
    return;
  }

  const nextIds = new Set(tabs.map((tab) => tab.id));
  let changed = false;

  for (const tab of tabs) {
    const prev = metaByTabId.get(tab.id);
    const nextPreview = Boolean(tab.preview);
    // patch 可能已先于 workspace state 写入 preview=false，勿被陈旧 tabs 覆盖
    if (prev && prev.preview === false && nextPreview) {
      continue;
    }
    if (
      prev &&
      prev.type === tab.type &&
      sameOptionalFlag(prev.dirty, tab.dirty) &&
      sameOptionalFlag(prev.saved, tab.saved) &&
      sameOptionalFlag(prev.preview, nextPreview) &&
      prev.icon === tab.icon &&
      prev.label === tab.label &&
      sameOptionalFlag(prev.tabBarHidden, tab.tabBarHidden)
    ) {
      continue;
    }
    metaByTabId.set(tab.id, {
      type: tab.type,
      dirty: tab.dirty,
      saved: tab.saved,
      preview: nextPreview,
      icon: tab.icon,
      label: tab.label,
      tabBarHidden: tab.tabBarHidden,
      rev: (prev?.rev ?? 0) + 1,
    });
    changed = true;
  }

  for (const id of metaByTabId.keys()) {
    if (!nextIds.has(id)) {
      metaByTabId.delete(id);
      changed = true;
    }
  }

  if (changed) {
    lastPublishedTabMetaFingerprint = fingerprint;
    emit();
  }
}

/** 编辑/保存等操作时即时刷新 Tab 头（不等待 dockview tabs prop 同步）。 */
export function patchDockTabFileMeta(
  tabId: string,
  patch: Pick<DockTabLiveMeta, "type" | "dirty" | "saved">,
): void {
  const prev = metaByTabId.get(tabId);
  if (
    prev &&
    prev.type === patch.type &&
    prev.dirty === patch.dirty &&
    prev.saved === patch.saved
  ) {
    return;
  }
  metaByTabId.set(tabId, {
    type: patch.type,
    dirty: patch.dirty,
    saved: patch.saved,
    preview: prev?.preview,
    icon: prev?.icon,
    label: prev?.label,
    rev: (prev?.rev ?? 0) + 1,
  });
  emit();
}

/** 预览 Tab 升级为常驻 / 打开预览 Tab 时即时刷新 Tab 头样式（不等待 tabs prop 同步）。 */
export function patchDockTabPreviewMeta(tabId: string, preview: boolean): void {
  const prev = metaByTabId.get(tabId);
  if (prev && Boolean(prev.preview) === preview) {
    return;
  }
  metaByTabId.set(tabId, {
    type: prev?.type,
    dirty: prev?.dirty,
    saved: prev?.saved,
    preview,
    icon: prev?.icon,
    label: prev?.label,
    rev: (prev?.rev ?? 0) + 1,
  });
  emit();
}

export function useDockTabLiveMeta(tabId: string): DockTabLiveMeta {
  return useSyncExternalStore(
    subscribe,
    () => getSnapshot(tabId),
    () => getSnapshot(tabId),
  );
}
