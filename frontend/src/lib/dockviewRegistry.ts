import type { DockviewApi, DockviewDidDropEvent, DockviewWillDropEvent } from "dockview-react";
import {
  MAX_WORKSPACE_PANELS,
  useWorkspaceBottomDockStore,
} from "../stores/workspaceBottomDockStore";

const WORKSPACE_BOTTOM_PREFIX = "workspace-bottom-";

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

type RelayoutRequest = {
  scopePrefix?: string;
  size?: { width: number; height: number };
};

const pendingRelayouts: RelayoutRequest[] = [];
let relayoutScheduled = false;

/** 容器尺寸变化后触发布局刷新（折叠/展开后 dockview 需重算） */
function relayoutDockviewInstancesNow(
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
      // 显式传入全屏尺寸时，跳过 display:none 的隐藏工作区 dock，避免 N 份无效 layout
      if (
        size &&
        layoutShell &&
        (!measured || measured.width <= 0 || measured.height <= 0)
      ) {
        continue;
      }
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
      } else if (!size) {
        window.dispatchEvent(new Event("resize"));
      }
    } catch {
      // teardown 或 transient 状态下 layout 可能失败，忽略
    }
  }
}

/** 同帧内合并多次 relayout 请求，避免切换/resize 时重复 layout。 */
export function relayoutDockviewInstances(
  scopePrefix?: string,
  size?: { width: number; height: number },
): void {
  const existing = pendingRelayouts.find((r) => r.scopePrefix === scopePrefix);
  if (existing) {
    if (size) existing.size = size;
  } else {
    pendingRelayouts.push({ scopePrefix, size });
  }
  if (relayoutScheduled) return;
  relayoutScheduled = true;
  requestAnimationFrame(() => {
    relayoutScheduled = false;
    const batch = pendingRelayouts.splice(0, pendingRelayouts.length);
    for (const req of batch) {
      relayoutDockviewInstancesNow(req.scopePrefix, req.size);
    }
  });
}

export const DOCK_SCOPE_RESYNC_EVENT = "omnipanel-dock-scope-resync";

/** 请求指定 scope 的 DockableWorkspace 从 store 重新同步缺失的 panel */
export function requestDockScopeResync(scope: string): void {
  window.dispatchEvent(
    new CustomEvent(DOCK_SCOPE_RESYNC_EVENT, { detail: { scope } }),
  );
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

/** 焦点/事件目标落在哪个 dockview 容器内（快捷键关 Tab 等回退定位） */
export function findDockviewInstanceContainingElement(
  el: Element | null,
): (DockviewInstanceScope & { viewId: string }) | undefined {
  if (!el) return undefined;
  for (const [viewId, instance] of instancesByViewId) {
    const container =
      instance.getContainer?.() ??
      (instance.api as DockviewApi & { element?: HTMLElement }).element ??
      null;
    if (container?.contains(el)) {
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
  const hit = document.elementFromPoint(clientX, clientY);
  if (hit) {
    const hostPanel = hit.closest<HTMLElement>("[data-workspace-id]");
    if (hostPanel?.dataset.workspaceId) {
      const inst = getDockviewInstanceByScope(
        `workspace-bottom-${hostPanel.dataset.workspaceId}`,
      );
      if (inst) return inst;
    }
  }

  const elements = document.elementsFromPoint(clientX, clientY);
  if (elements.length === 0) return undefined;

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

/** 指针落点是否落在某模块 dockview 容器内（终端 / 数据库 / 文件等）。 */
export function findModuleDockAt(
  clientX: number,
  clientY: number,
): (DockviewInstanceScope & { viewId: string }) | undefined {
  const elements = document.elementsFromPoint(clientX, clientY);
  if (elements.length === 0) return undefined;

  const isModuleScope = (scope: string) => !scope.startsWith("workspace-bottom-");

  for (const el of elements) {
    for (const [viewId, instance] of instancesByViewId) {
      if (!isModuleScope(instance.scope)) continue;
      const container =
        instance.getContainer?.() ??
        (instance.api as DockviewApi & { element?: HTMLElement }).element ??
        null;
      if (container?.contains(el)) {
        return { ...instance, viewId };
      }
    }

    const host = el.closest(
      ".dockable-workspace:not(.workspace-panel-dock), .module-segment-dock, .terminal-module-dock, .database-module-dock, .files-workspace",
    );
    if (!host) continue;
    for (const [viewId, instance] of instancesByViewId) {
      if (!isModuleScope(instance.scope)) continue;
      const container = instance.getContainer?.();
      if (container && host.contains(container)) {
        return { ...instance, viewId };
      }
    }
  }

  for (const [viewId, instance] of instancesByViewId) {
    if (!isModuleScope(instance.scope)) continue;
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

  // 容量预检：目标若是 workspace dock 且已满（含待转移 panelId 时仍允许更新），
  // 提前拒绝 transfer，避免 addMirroredTab/addPayloadTab 静默不添加但 removePanel 已执行导致 tab 丢失。
  if (target.scope.startsWith(WORKSPACE_BOTTOM_PREFIX)) {
    const workspaceId = target.scope.slice(WORKSPACE_BOTTOM_PREFIX.length);
    const currentTabs =
      useWorkspaceBottomDockStore.getState().tabsByWorkspace[workspaceId] ?? [];
    const alreadyTracked = currentTabs.some((t) => t.id === newPanelId);
    if (currentTabs.length >= MAX_WORKSPACE_PANELS && !alreadyTracked) {
      // eslint-disable-next-line no-console
      console.warn(
        `[crossDock][transfer][reject-capacity] source=${source.scope}/${panelId} -> target=${target.scope} current=${currentTabs.length} max=${MAX_WORKSPACE_PANELS}`,
      );
      return false;
    }
  }

  // eslint-disable-next-line no-console
  console.info(
    `[crossDock][transfer][start] source=${source.scope}/${panelId} -> target=${target.scope} newPanelId=${newPanelId}`,
  );

  // 记录 workspace 目标在 emit 前的 tabs 状态，用于同步检查 listener 是否成功落地
  const targetWorkspaceId = target.scope.startsWith(WORKSPACE_BOTTOM_PREFIX)
    ? target.scope.slice(WORKSPACE_BOTTOM_PREFIX.length)
    : null;
  const beforeTabs =
    targetWorkspaceId !== null
      ? (useWorkspaceBottomDockStore.getState().tabsByWorkspace[targetWorkspaceId] ?? [])
          .map((t) => t.id)
      : null;

  emitTransfer({
    newPanelId,
    title,
    originScope: source.scope,
    originPanelId: panelId,
    params: (panelDef?.params ?? {}) as Record<string, unknown>,
  });

  // 同步校验：emit 后目标 store 是否真的收到了 newPanelId？
  // 失败原因通常是 buildWorkspaceTabFromModuleTransfer 返回 null（终端 tab 找不到、
  // 数据库 mirror 缺失等），若不拦截会同时污染 source store（setTabWorkspaceOnly 触发
  // syncTabsToApi 移除 panel）导致 tab 真的丢失。
  if (targetWorkspaceId !== null && beforeTabs !== null) {
    const afterTabs =
      useWorkspaceBottomDockStore.getState().tabsByWorkspace[targetWorkspaceId] ?? [];
    const transferLanded = afterTabs.some((t) => t.id === newPanelId);
    if (!transferLanded) {
      // eslint-disable-next-line no-console
      console.error(
        `[crossDock][transfer][abort-no-land] source=${source.scope}/${panelId} -> target=${target.scope} newPanelId=${newPanelId} 不在 workspace store，放弃本次转移以避免 tab 丢失`,
      );
      return false;
    }
  }

  // 仅当目标确认收到后才通知源端迁出（避免 source.setTabWorkspaceOnly 触发 syncTabsToApi 把 panel 移除）
  source.onPanelTransferredOut?.(panelId, target.scope);

  // 须在 dockview pointer 拖拽收尾后再 removePanel，否则 movingLock 内会抛 invalid operation
  const deferRemove = () => {
    try {
      const lingering = source.api.getPanel(panelId);
      if (lingering) {
        source.api.removePanel(lingering);
        // eslint-disable-next-line no-console
        console.info(
          `[crossDock][transfer][deferRemove] source=${source.scope}/${panelId} removed`,
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[crossDock][transfer][deferRemove-err] source=${source.scope}/${panelId}`,
        err,
      );
    }
  };
  requestAnimationFrame(() => {
    requestAnimationFrame(deferRemove);
  });

  // eslint-disable-next-line no-console
  console.info(
    `[crossDock][transfer][ok] source=${source.scope}/${panelId} -> target=${target.scope} newPanelId=${newPanelId}`,
  );

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
