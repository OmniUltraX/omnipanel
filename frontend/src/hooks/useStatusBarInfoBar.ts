import { useEffect, useRef, useSyncExternalStore, type DependencyList, type ReactNode } from "react";
import { useStatusBarActionBarStore } from "../stores/statusBarActionBarStore";

type InfoBarRender = () => ReactNode;

const entries = new Map<string, InfoBarRender>();
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

function registerStatusBarInfoBar(panelId: string, render: InfoBarRender): () => void {
  entries.set(panelId, render);
  emitRegistryChange();
  return () => {
    if (!entries.has(panelId)) return;
    entries.delete(panelId);
    emitRegistryChange();
  };
}

export function getStatusBarInfoBarContent(panelId: string | null): ReactNode {
  if (!panelId) return null;
  const render = entries.get(panelId);
  return render?.() ?? null;
}

/** 当前 dock 面板是否为状态栏 InfoBar 的激活目标 */
export function useStatusBarInfoBarActive(panelId: string): boolean {
  const activePanelId = useStatusBarActionBarStore(
    (state) => state.activeDock?.panelId ?? null,
  );
  return activePanelId === panelId;
}

/**
 * 为 dock 面板注册状态栏 InfoBar 内容（panelId 通常与 tabId 一致）。
 * 仅当该面板为当前激活 dock panel 时才会在状态栏展示。
 */
export function useStatusBarInfoBar(
  panelId: string,
  render: InfoBarRender | null,
  enabled = true,
  deps: DependencyList = [],
): void {
  const renderRef = useRef(render);
  renderRef.current = render;

  useEffect(() => {
    if (!enabled || !renderRef.current) return;
    return registerStatusBarInfoBar(panelId, () => renderRef.current?.() ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps 由调用方显式传入以刷新 InfoBar
  }, [panelId, enabled, ...deps]);
}

/** 订阅 InfoBar 注册表变更（供 StatusBarInfoBar 使用） */
export function useStatusBarInfoBarRegistryRev(): number {
  return useSyncExternalStore(subscribeRegistry, getRegistryRev, getRegistryRev);
}
