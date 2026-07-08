import type { DockviewApi, DockviewDidDropEvent, DockviewWillDropEvent } from "dockview-react";

export interface DockviewInstanceScope {
  scope: string;
  api: DockviewApi;
  /** 返回 dockview 根节点，用于测量 layout 尺寸 */
  getContainer?: () => HTMLElement | null;
  /** panel 被拖离本 dock 时回调（仅从布局移除，不销毁业务数据） */
  onPanelTransferredOut?: (panelId: string, targetScope: string) => void;
}

export interface TransferredPanelMeta {
  newPanelId: string;
  title: string;
  originScope: string;
  originPanelId: string;
  params: Record<string, unknown>;
}

type TransferListener = (meta: TransferredPanelMeta) => void;

const instancesByViewId = new Map<string, DockviewInstanceScope>();
const scopeByViewId = new Map<string, string>();
const transferListeners = new Set<TransferListener>();

/** 容器尺寸变化后触发布局刷新（折叠/展开后 dockview 需重算） */
export function relayoutDockviewInstances(
  scopePrefix?: string,
  size?: { width: number; height: number },
): void {
  for (const instance of instancesByViewId.values()) {
    if (scopePrefix && !instance.scope.startsWith(scopePrefix)) continue;
    try {
      const api = instance.api as DockviewApi & {
        layout?: (width: number, height: number, force?: boolean) => void;
        element?: HTMLElement;
      };
      const dockviewRoot =
        instance.getContainer?.() ??
        (api.element?.closest(".dockable-workspace__dockview") as HTMLElement | null) ??
        api.element ??
        null;
      const layoutShell =
        (dockviewRoot?.closest(".dockable-workspace") as HTMLElement | null) ??
        dockviewRoot;
      const measured = layoutShell?.getBoundingClientRect();
      const width = Math.round(
        size?.width && size.width > 0
          ? size.width
          : measured && measured.width > 0
            ? measured.width
            : 0,
      );
      const height = Math.round(
        size?.height && size.height > 0
          ? size.height
          : measured && measured.height > 0
            ? measured.height
            : 0,
      );

      if (typeof api.layout === "function" && width > 0 && height > 0) {
        api.layout(width, height, true);
      } else {
        window.dispatchEvent(new Event("resize"));
      }
    } catch {
      // teardown 或 transient 状态下 layout 可能失败，忽略
    }
  }
}

export function registerDockviewInstance(
  viewId: string,
  instance: DockviewInstanceScope,
): void {
  instancesByViewId.set(viewId, instance);
  scopeByViewId.set(viewId, instance.scope);
}

export function unregisterDockviewInstance(viewId: string): void {
  instancesByViewId.delete(viewId);
  scopeByViewId.delete(viewId);
}

export function getDockviewInstance(viewId: string): DockviewInstanceScope | undefined {
  return instancesByViewId.get(viewId);
}

export function subscribeDockviewTransfer(listener: TransferListener): () => void {
  transferListeners.add(listener);
  return () => transferListeners.delete(listener);
}

function emitTransfer(meta: TransferredPanelMeta): void {
  for (const listener of transferListeners) {
    listener(meta);
  }
}

/**
 * 将其他 dockview 实例中的 panel 移入目标实例，并通知订阅方更新 tab 元数据。
 */
export function transferPanelToTarget(
  targetViewId: string,
  event: DockviewDidDropEvent | DockviewWillDropEvent,
): boolean {
  const data = event.getData();
  if (!data?.panelId || data.viewId === targetViewId) return false;

  const source = instancesByViewId.get(data.viewId);
  const target = instancesByViewId.get(targetViewId);
  if (!source || !target) return false;

  const sourcePanel = source.api.getPanel(data.panelId);
  if (!sourcePanel) return false;

  const serialized = source.api.toJSON();
  const panelDef = serialized.panels?.[data.panelId];
  const title = sourcePanel.api.title || data.panelId;
  const newPanelId = `${target.scope}:${data.panelId}`;

  if (target.api.getPanel(newPanelId)) {
    return false;
  }

  // 先更新目标 store，再由 DockableWorkspace tabs 同步 effect 执行 addPanel。
  // 若此处直接 addPanel，tabs effect 可能在 store 更新前移除刚加入的 panel。
  emitTransfer({
    newPanelId,
    title,
    originScope: source.scope,
    originPanelId: data.panelId,
    params: (panelDef?.params ?? {}) as Record<string, unknown>,
  });

  // 须在 removePanel 之前标记，否则 onDidRemovePanel 会误触发 onCloseTab 销毁源 tab 数据
  source.onPanelTransferredOut?.(data.panelId, target.scope);
  source.api.removePanel(sourcePanel);

  return true;
}
