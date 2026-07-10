import { useEffect, useRef, useSyncExternalStore, type DependencyList, type ReactNode } from "react";
import { useStatusBarActionBarStore } from "../stores/statusBarActionBarStore";

type ActionBarRender = () => ReactNode;

export type StatusBarActionBarMeta = {
  /** 覆盖 dock panelType 解析出的类型标签 */
  triggerLabel?: string;
  /** 触发按钮上展示的当前值摘要（如 CSV / TSV） */
  summary?: string;
};

type ActionBarEntry = {
  render: ActionBarRender;
  meta: StatusBarActionBarMeta;
};

const entries = new Map<string, ActionBarEntry>();
const listeners = new Set<() => void>();
let registryRev = 0;

function emitRegistryChange() {
  registryRev += 1;
  for (const listener of listeners) {
    listener();
  }
}

function subscribeRegistry(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getRegistryRev(): number {
  return registryRev;
}

function registerStatusBarActionBar(
  panelId: string,
  render: ActionBarRender,
  meta: StatusBarActionBarMeta = {},
): () => void {
  entries.set(panelId, { render, meta });
  emitRegistryChange();
  return () => {
    if (!entries.has(panelId)) return;
    entries.delete(panelId);
    emitRegistryChange();
  };
}

export function getStatusBarActionBarContent(panelId: string | null): ReactNode {
  if (!panelId) return null;
  const entry = entries.get(panelId);
  return entry?.render() ?? null;
}

export function getStatusBarActionBarMeta(panelId: string | null): StatusBarActionBarMeta {
  if (!panelId) return {};
  return entries.get(panelId)?.meta ?? {};
}

/** 当前 dock 面板是否为状态栏 ActionBar 的激活目标 */
export function useStatusBarActionBarActive(panelId: string): boolean {
  const activePanelId = useStatusBarActionBarStore(
    (state) => state.activeDock?.panelId ?? null,
  );
  return activePanelId === panelId;
}

/**
 * 为 dock 面板注册状态栏 ActionBar 内容（panelId 通常与 tabId 一致）。
 * 仅当该面板为当前激活 dock panel 时才会在状态栏展示。
 */
export function useStatusBarActionBar(
  panelId: string,
  render: ActionBarRender | null,
  enabled = true,
  deps: DependencyList = [],
  meta: StatusBarActionBarMeta = {},
): void {
  const renderRef = useRef(render);
  renderRef.current = render;
  const metaRef = useRef(meta);
  metaRef.current = meta;

  useEffect(() => {
    if (!enabled || !renderRef.current) return;
    return registerStatusBarActionBar(
      panelId,
      () => renderRef.current?.() ?? null,
      metaRef.current,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps 由调用方显式传入以刷新 ActionBar
  }, [panelId, enabled, meta.triggerLabel, meta.summary, ...deps]);
}

/** 订阅 ActionBar 注册表变更（供 StatusBarActionBar 使用） */
export function useStatusBarActionBarRegistryRev(): number {
  return useSyncExternalStore(subscribeRegistry, getRegistryRev, getRegistryRev);
}
