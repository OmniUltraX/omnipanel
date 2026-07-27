import type { DockviewApi, DockviewDidDropEvent, DockviewWillDropEvent } from "dockview-react";
import {
  MAX_WORKSPACE_PANELS,
  useWorkspaceBottomDockStore,
} from "../stores/workspaceBottomDockStore";
import { crossDockDebugInfo, crossDockDebugWarn } from "./crossDockDebug";

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

function isDockLayoutShellHidden(layoutShell: HTMLElement | null): boolean {
  if (!layoutShell) return true;
  // data-visible=false 的预热/折叠 dock：跳过，避免无效 layout + 强制回流
  if (layoutShell.closest('[data-visible="false"]')) return true;
  return false;
}

/** 容器尺寸变化后触发布局刷新（折叠/展开后 dockview 需重算） */
function relayoutDockviewInstancesNow(
  scopePrefix?: string,
  size?: { width: number; height: number },
): void {
  const hasExplicitSize = Boolean(size && size.width > 0 && size.height > 0);

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

      if (isDockLayoutShellHidden(layoutShell)) {
        continue;
      }

      let width = 0;
      let height = 0;

      if (hasExplicitSize && size) {
        // 已有明确尺寸时跳过 getBoundingClientRect，避免与 dockview 内部测量叠加重回流
        width = Math.round(size.width);
        height = Math.round(size.height);
      } else {
        const measured = layoutShell?.getBoundingClientRect();
        width = Math.round(measured && measured.width > 0 ? measured.width : 0);
        height = Math.round(measured && measured.height > 0 ? measured.height : 0);
      }

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

/** 记录各 api 上一次计入的 AI 宽度，用于从「含 gutter 的列宽」还原内容比例 */
const prevAiWidthByApi = new WeakMap<object, number>();

/**
 * 读取 AI Dock 当前渲染宽度。rect 已包含 CSS `min(var(--ai-dock-w), 50vw)`
 * 的钳制，与内容区 margin-right 完全一致；关闭时为 0。
 */
function readAiDockWidthPx(): number {
  if (typeof document === "undefined") return 0;
  const dock = document.querySelector(".workspace .ai-dockview.open");
  if (dock instanceof HTMLElement) {
    const rendered = Math.round(dock.getBoundingClientRect().width);
    if (rendered > 0) return rendered;
  }
  return 0;
}

/** 每列内容的最小保底宽度，低于此宽度时放弃重算（AI 占比过大） */
const MIN_COLUMN_CONTENT_PX = 80;

/**
 * 顶层左右列：按 group DOM 的 left 坐标聚类（同列多 group 取一个代表）。
 * 不依赖 dockview 内部 DOM 层级选择器。
 */
function resolveHorizontalColumns(
  api: DockviewApi,
): Array<{ group: DockviewApi["groups"][number] }> {
  const clusters: Array<{ left: number; group: DockviewApi["groups"][number] }> = [];
  for (const group of api.groups) {
    let rect: DOMRect;
    try {
      rect = group.element.getBoundingClientRect();
    } catch {
      continue;
    }
    if (rect.width <= 0) continue;
    const left = Math.round(rect.left);
    if (clusters.some((c) => Math.abs(c.left - left) <= 4)) continue;
    clusters.push({ left, group });
  }
  clusters.sort((a, b) => a.left - b.left);
  return clusters.map((c) => ({ group: c.group }));
}

/**
 * AI Dock 打开时内容用 margin 避开侧栏，dockview 仍按全宽分栏。
 * 这里按「扣除 AI 后的剩余宽度」重算顶层列宽：
 * 非末列 = 内容份额；末列 = 内容份额 + AI 宽（列宽总和仍为全宽）。
 */
export function rebalanceHorizontalSplitsForAiDock(
  api: DockviewApi,
  aiWidthPx: number,
  options?: { forceEqual?: boolean },
): void {
  const totalW = Math.round(api.width);
  if (totalW <= 0) return;

  const anyGroupEl = api.groups[0]?.element ?? null;
  const layoutShell = anyGroupEl?.closest(".dockable-workspace") as HTMLElement | null;
  if (!layoutShell?.classList.contains("dock-window-control")) return;
  if (isDockLayoutShellHidden(layoutShell)) return;

  // 注意：aiW 不能再按 totalW 的比例封顶——CSS margin 用的是
  // min(var(--ai-dock-w), 50vw)，与 dock 自身宽度无关；两边不一致会把末列内容整段盖掉。
  const aiW = Math.max(0, Math.round(aiWidthPx));

  const columns = resolveHorizontalColumns(api);
  if (columns.length < 2) {
    prevAiWidthByApi.set(api, aiW);
    return;
  }

  const usable = totalW - aiW;
  if (usable < columns.length * MIN_COLUMN_CONTENT_PX) {
    // AI 占比过大，重算无意义；不更新 prevAi，等宽度恢复后再按旧基线还原
    return;
  }

  const prevAi = prevAiWidthByApi.get(api) ?? 0;
  const sizes = columns.map((c) => Math.max(1, Math.round(c.group.api.width)));
  // 两列几乎等宽 → 刚分栏，dockview 按全宽 50/50，需强制按剩余宽度均分
  const nearlyEqual =
    columns.length === 2 &&
    Math.abs(sizes[0] - sizes[1]) <= Math.max(8, totalW * 0.04);
  const forceEqual = Boolean(options?.forceEqual) || nearlyEqual;

  // 目标内容宽：均分或按现有内容比例（末列先扣掉上次计入的 AI 宽）
  let contents: number[];
  if (forceEqual) {
    contents = columns.map(() => Math.floor(usable / columns.length));
  } else {
    const currentContents = sizes.map((w, i) =>
      i === columns.length - 1 ? Math.max(1, w - prevAi) : w,
    );
    const sum = currentContents.reduce((a, b) => a + b, 0);
    if (sum <= 0) {
      prevAiWidthByApi.set(api, aiW);
      return;
    }
    contents = currentContents.map((w) =>
      Math.max(1, Math.round((w / sum) * usable)),
    );
  }
  // 末列吸收取整误差 + AI 宽
  const usedByOthers = contents.slice(0, -1).reduce((a, b) => a + b, 0);
  contents[contents.length - 1] = Math.max(1, usable - usedByOthers);

  for (let i = 0; i < columns.length; i++) {
    const isLast = i === columns.length - 1;
    const nextWidth = isLast ? contents[i] + aiW : contents[i];
    if (Math.abs(Math.round(columns[i].group.api.width) - nextWidth) <= 1) continue;
    try {
      columns[i].group.api.setSize({ width: nextWidth });
    } catch {
      // teardown / transient 状态下 setSize 可能抛错，忽略
    }
  }
  prevAiWidthByApi.set(api, aiW);
}

/** 对所有已注册 dock 重算（内部会跳过非 windowControl / 隐藏实例） */
export function rebalanceAllHorizontalSplitsForAiDock(
  aiWidthPx?: number,
  options?: { forceEqual?: boolean },
): void {
  const width = aiWidthPx ?? readAiDockWidthPx();
  const seen = new Set<DockviewApi>();
  for (const instance of instancesByViewId.values()) {
    if (seen.has(instance.api)) continue;
    seen.add(instance.api);
    try {
      rebalanceHorizontalSplitsForAiDock(instance.api, width, options);
    } catch {
      // ignore
    }
  }
}

let rebalanceScheduled = false;
let rebalancePendingForceEqual = false;

/**
 * 分栏/开合/调宽后延迟重算。
 * 同帧内多次调用只执行一次；AI 宽度在「执行时」实时读 DOM，
 * 不在调度时捕获——否则快速开合时晚到的旧回调会用过期宽度覆盖新状态。
 */
export function scheduleRebalanceHorizontalSplitsForAiDock(
  options?: { forceEqual?: boolean },
): void {
  if (options?.forceEqual) rebalancePendingForceEqual = true;
  if (rebalanceScheduled) return;
  rebalanceScheduled = true;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      rebalanceScheduled = false;
      const forceEqual = rebalancePendingForceEqual;
      rebalancePendingForceEqual = false;
      rebalanceAllHorizontalSplitsForAiDock(readAiDockWidthPx(), { forceEqual });
    });
  });
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

  // 预解析 workspace 实例容器一次，避免「元素 × 实例」双层循环里重复调用
  // getContainer() 与类型断言（拖拽 pointermove 高频触发；instances 少但元素可能多个）。
  const candidates: Array<{
    viewId: string;
    instance: DockviewInstanceScope;
    container: HTMLElement | null;
  }> = [];
  for (const [viewId, instance] of instancesByViewId) {
    if (!instance.scope.startsWith("workspace-bottom-")) continue;
    const container =
      instance.getContainer?.() ??
      (instance.api as DockviewApi & { element?: HTMLElement }).element ??
      null;
    candidates.push({ viewId, instance, container });
  }

  for (const el of elements) {
    for (const cand of candidates) {
      if (cand.container?.contains(el)) {
        return { ...cand.instance, viewId: cand.viewId };
      }
    }
  }

  for (const cand of candidates) {
    if (!cand.container) continue;
    const rect = cand.container.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (
      clientX >= rect.left &&
      clientX < rect.right &&
      clientY >= rect.top &&
      clientY < rect.bottom
    ) {
      return { ...cand.instance, viewId: cand.viewId };
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

  // 预解析模块实例容器一次，避免「元素 × 实例」双层循环里重复调用 getContainer() 与类型断言。
  // containerFull 用于 contains/rect 命中（与原逻辑一致：getContainer ?? api.element）；
  // containerRaw 仅用于 host.contains 检测（原逻辑只取 getContainer，保留该语义以免误命中）。
  const candidates: Array<{
    viewId: string;
    instance: DockviewInstanceScope;
    containerFull: HTMLElement | null;
    containerRaw: HTMLElement | null;
  }> = [];
  for (const [viewId, instance] of instancesByViewId) {
    if (!instance.scope.startsWith("workspace-bottom-")) continue;
    const containerRaw = instance.getContainer?.() ?? null;
    const containerFull =
      containerRaw ??
      (instance.api as DockviewApi & { element?: HTMLElement }).element ??
      null;
    candidates.push({ viewId, instance, containerFull, containerRaw });
  }

  for (const el of elements) {
    for (const cand of candidates) {
      if (cand.containerFull?.contains(el)) {
        return { ...cand.instance, viewId: cand.viewId };
      }
    }

    const host = el.closest(
      ".dockable-workspace:not(.workspace-panel-dock), .module-segment-dock, .terminal-module-dock, .database-module-dock, .files-workspace",
    );
    if (!host) continue;
    for (const cand of candidates) {
      if (cand.containerRaw && host.contains(cand.containerRaw)) {
        return { ...cand.instance, viewId: cand.viewId };
      }
    }
  }

  for (const cand of candidates) {
    if (!cand.containerFull) continue;
    const rect = cand.containerFull.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (
      clientX >= rect.left &&
      clientX < rect.right &&
      clientY >= rect.top &&
      clientY < rect.bottom
    ) {
      return { ...cand.instance, viewId: cand.viewId };
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
      crossDockDebugWarn(
        `[crossDock][transfer][reject-capacity] source=${source.scope}/${panelId} -> target=${target.scope} current=${currentTabs.length} max=${MAX_WORKSPACE_PANELS}`,
      );
      return false;
    }
  }

  crossDockDebugInfo(
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
        crossDockDebugInfo(
          `[crossDock][transfer][deferRemove] source=${source.scope}/${panelId} removed`,
        );
      }
    } catch (err) {
      crossDockDebugWarn(
        `[crossDock][transfer][deferRemove-err] source=${source.scope}/${panelId}`,
        err,
      );
    }
  };
  requestAnimationFrame(() => {
    requestAnimationFrame(deferRemove);
  });

  crossDockDebugInfo(
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
