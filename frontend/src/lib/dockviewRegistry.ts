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

export function getDockviewInstanceByScope(
  scope: string,
): (DockviewInstanceScope & { viewId: string }) | undefined {
  for (const [viewId, instance] of instancesByViewId) {
    if (instance.scope === scope) {
      return { ...instance, viewId };
    }
  }
  return undefined;
}

/** 在终端/数据库等模块 dock 中查找 panel 所在实例。 */
export function findModuleDockPanelById(
  panelId: string,
): (DockviewInstanceScope & { viewId: string }) | undefined {
  for (const [viewId, instance] of instancesByViewId) {
    if (instance.scope.startsWith("workspace-bottom-")) continue;
    try {
      if (instance.api.getPanel(panelId)) {
        return { ...instance, viewId };
      }
    } catch {
      // teardown 期间 getPanel 可能抛错
    }
  }
  return undefined;
}

/** 指针落点是否落在某工程工作区 dockview 容器内 */
export function findEngineeringWorkspaceDockAt(
  clientX: number,
  clientY: number,
): (DockviewInstanceScope & { viewId: string }) | undefined {
  const elements = document.elementsFromPoint(clientX, clientY);
  if (elements.length === 0) return undefined;

  const findInHost = (host: Element): (DockviewInstanceScope & { viewId: string }) | undefined => {
    for (const [viewId, instance] of instancesByViewId) {
      if (!instance.scope.startsWith("workspace-bottom-")) continue;
      const container = instance.getContainer?.();
      if (container && host.contains(container)) {
        return { ...instance, viewId };
      }
    }
    return undefined;
  };

  for (const el of elements) {
    for (const [viewId, instance] of instancesByViewId) {
      if (!instance.scope.startsWith("workspace-bottom-")) continue;
      const container =
        instance.getContainer?.() ??
        (instance.api as DockviewApi & { element?: HTMLElement }).element ??
        null;
      if (container?.contains(el)) {
        return { ...instance, viewId };
      }
    }

    const host = el.closest(
      ".workspace-bottom-host, .workspace-panel-dock, .dock-panel-bottom--workspace, .workspace-panel-frame",
    );
    if (host) {
      const found = findInHost(host);
      if (found) return found;
    }
  }

  for (const [viewId, instance] of instancesByViewId) {
    if (!instance.scope.startsWith("workspace-bottom-")) continue;
    const container =
      instance.getContainer?.() ??
      (instance.api as DockviewApi & { element?: HTMLElement }).element ??
      null;
    if (!container) continue;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (
      clientX >= rect.left &&
      clientX < rect.right &&
      clientY >= rect.top &&
      clientY < rect.bottom
    ) {
      return { ...instance, viewId };
    }
  }

  return undefined;
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
 * 将源 dockview 中的 panel 移入目标实例，并通知订阅方更新 tab 元数据。
 */
export function transferPanelBetweenInstances(
  sourceViewId: string,
  panelId: string,
  targetViewId: string,
): boolean {
  if (!panelId || sourceViewId === targetViewId) return false;

  const source = instancesByViewId.get(sourceViewId);
  const target = instancesByViewId.get(targetViewId);
  if (!source || !target) return false;

  const sourcePanel = source.api.getPanel(panelId);
  if (!sourcePanel) return false;

  const serialized = source.api.toJSON();
  const panelDef = serialized.panels?.[panelId];
  const title = sourcePanel.api.title || panelId;
  const newPanelId = `${target.scope}:${panelId}`;

  if (target.api.getPanel(newPanelId)) {
    return false;
  }

  emitTransfer({
    newPanelId,
    title,
    originScope: source.scope,
    originPanelId: panelId,
    params: (panelDef?.params ?? {}) as Record<string, unknown>,
  });

  source.onPanelTransferredOut?.(panelId, target.scope);
  // 须在 dockview pointer 拖拽收尾后再 removePanel，否则 movingLock 内会抛 invalid operation
  const deferRemove = () => {
    try {
      const lingering = source.api.getPanel(panelId);
      if (lingering) {
        source.api.removePanel(lingering);
      }
    } catch {
      // 拖拽周期内 panel 可能已被 dockview 自行处理
    }
  };
  requestAnimationFrame(() => {
    requestAnimationFrame(deferRemove);
  });

  return true;
}

/**
 * 将其他 dockview 实例中的 panel 移入目标实例，并通知订阅方更新 tab 元数据。
 */
export function transferPanelToTarget(
  targetViewId: string,
  event: DockviewDidDropEvent | DockviewWillDropEvent,
): boolean {
  const data = event.getData();
  if (!data?.panelId) return false;
  return transferPanelBetweenInstances(data.viewId, data.panelId, targetViewId);
}
