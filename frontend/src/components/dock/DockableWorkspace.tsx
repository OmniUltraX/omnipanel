import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewHeaderActionsProps,
  type IDockviewPanel,
  type IDockviewPanelProps,
  type SerializedDockview,
  type DockviewDidDropEvent,
  type DockviewWillDropEvent,
  themeDark,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import {
  mergePanelsIntoLayout,
  collectPanelIds,
  normalizeDockLayout,
  enrichLayoutWithTabMeta,
  isLayoutUsable,
  describeDockLayout,
  reorderLayoutViews,
  layoutStructureFingerprint,
} from "./dockViewLayout";
import { DockErrorBoundary } from "./DockErrorBoundary";
import {
  registerDockviewInstance,
  transferPanelToTarget,
  unregisterDockviewInstance,
  getDockviewInstance,
  DOCK_SCOPE_RESYNC_EVENT,
} from "../../lib/dockviewRegistry";
import { isWorkspaceDockOutboundTransfer } from "../../lib/crossWindowDockTransfer";
import {
  isModuleDockScope,
  shouldTransferModuleToWorkspace,
  shouldTransferWorkspaceToModule,
} from "../../lib/moduleToWorkspaceTransfer";
import { syncTabGroupsByPanelType, clearTabGroups } from "./dockTabGroups";
import { DockWorkspaceTabHeader } from "./DockWorkspaceTabHeader";
import {
  DockTabHeaderRuntimeContext,
  type DockTabHeaderRuntime,
} from "./dockTabHeaderRuntime";
import { TopbarTabAddButton } from "../ui/TopbarTabAddButton";
import type { TopbarAddMenuItem } from "../../stores/topbarStore";
import type { TopbarTabDef } from "../../stores/topbarStore";
import { syncPanelTabParams, tabParamsFromDockableTab } from "./dockTabParams";
import { publishDockTabMeta } from "./dockTabLiveMeta";
import type { DockHeaderIconKind } from "./DockHeaderIcon";
import type { DockTabPageType } from "./dockableTab";
import type { DockWindowChromeMode } from "./dockWindowChromeActions";
import { DockWindowChromeActions } from "./DockWindowTitleActions";
import { resolveDockWindowChromeLayout, resolveSegmentWindowChromeHosts } from "./dockWindowChromeLayout";
import {
  syncGroupHeaderPosition,
  type DockHeaderPosition,
} from "./dockHeaderPosition";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { DockableTab } from "./dockableTab";
import { useModuleVisibility } from "../../lib/moduleVisibility";
import {
  publishStatusBarActiveDock,
  useStatusBarActionBarStore,
} from "../../stores/statusBarActionBarStore";

export type { DockableTab } from "./dockableTab";

const VOID_WINDOW_DRAG_THRESHOLD_PX = 3;
const VOID_DOUBLE_CLICK_MS = 500;
const VOID_DOUBLE_CLICK_DISTANCE_PX = 12;
/** 顶栏 dock 低于此宽度时不调用 layout，避免把整页锁死在压扁态 */
const TOP_HEADER_MIN_LAYOUT_PX = 160;
const SIDE_HEADER_MIN_LAYOUT_PX = 36;

const TAB_BAR_INTERACTIVE_SELECTOR = [
  ".dv-tab",
  ".dv-default-tab",
  ".dock-tab-header-root",
  ".dv-default-tab-action",
  "button",
  ".win-controls",
  ".topbar-tab-add-wrap",
  ".topbar-tab-add",
  ".module-dock-title",
  ".dock-window-chrome-left-actions",
].join(",");

let lastDockMaximizeToggleAt = 0;

async function toggleDockWindowMaximize(): Promise<void> {
  const now = Date.now();
  if (now - lastDockMaximizeToggleAt < 400) return;
  lastDockMaximizeToggleAt = now;
  const win = getCurrentWindow();
  if (await win.isFullscreen()) {
    await win.setFullscreen(false);
  } else {
    await win.toggleMaximize();
  }
}

function findTabBarChromeTarget(
  root: HTMLElement,
  target: EventTarget | null,
): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null;
  const tabBar = target.closest<HTMLElement>(".dv-tabs-and-actions-container");
  if (!tabBar || !root.contains(tabBar)) return null;
  if (target.closest(TAB_BAR_INTERACTIVE_SELECTOR)) return null;
  return tabBar;
}

const DOCK_TAB_NO_DRAG_SELECTOR = [
  ".dv-scrollable",
  ".dv-tabs-container",
  ".dv-tab",
  ".dv-default-tab[data-dock-tab-id]",
  ".dv-left-actions-container",
].join(",");

export interface DockAddTabConfig {
  show?: boolean;
  title?: string;
  onAdd?: () => void;
  menuItems?: TopbarAddMenuItem[];
  onMenuSelect?: (id: string) => void;
}

import type { DockPanelRefreshProps } from "./dockPanelRefresh";

export interface DockableWorkspaceProps extends DockPanelRefreshProps {
  tabs: DockableTab[];
  activeTabId: string;
  onActiveTabChange: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  savedLayout: SerializedDockview | null;
  onSavedLayoutChange: (layout: SerializedDockview | null) => void;
  renderPanel: (tabId: string) => ReactNode;
  /** 按 tabId 局部 invalidate；优先于 panelContentKey 的全局 bump */
  panelContentKeysByTab?: Record<string, string>;
  className?: string;
  emptyContent?: ReactNode;
  onTabContextMenu?: (
    event: React.MouseEvent,
    tabId: string,
    index: number,
  ) => void;
  /** 预览 Tab 双击：升级为常驻 Tab */
  onTabDoubleClick?: (tabId: string) => void;
  /**
   * 通过 dockview `containerApi.addPanel` 创建新面板。
   * 返回新面板的 id / title；由调用方同步业务 store。
   */
  createPanelRequest?: () => { id: string; title: string } | null;
  /** 注册到全局 dock 实例表，用于跨 dockview 拖放 */
  dockScope?: string;
  /** 是否接受其他 dockview 拖入的 panel */
  acceptExternalDrops?: boolean;
  /** dragover：是否接受来自外部的 HTML5 拖放 */
  canAcceptExternalDrop?: (dataTransfer: DataTransfer) => boolean;
  /** drop：处理外部 HTML5 拖放（如 Schema 树节点） */
  onExternalDrop?: (dataTransfer: DataTransfer) => void;
  /** 自定义 tab group chip 标签与颜色 */
  resolveTabGroupMeta?: (
    panelType: string,
  ) => Partial<{ label: string; color: string }> | undefined;
  /** dockview group Tab 栏默认方位；`right` / `left` 为竖排侧栏 */
  defaultHeaderPosition?: DockHeaderPosition;
  /**
   * 同步重排入口：外层改变 dock 宽度后（如终端右侧栏展开），在 paint 前调用
   * `current()` 让 dockview 立即按真实尺寸重排，避免其自带 ResizeObserver
   * 异步重排导致竖排 tab 轨与内容停留在折叠态窄宽的一帧。
   */
  relayoutRef?: React.MutableRefObject<(() => void) | null>;
  /** 为 false 时不按 panelType 折叠为 tab group（数据库等同类型多 Tab 需直接展示） */
  enableTabGroups?: boolean;
  /** topbar 风格 tab 栏（终端 session tab） */
  tabStyle?: "default" | "topbar" | "segment";
  /** 右侧「+」新建 tab / 菜单（与顶栏 TopbarTabs 行为一致） */
  addTabConfig?: DockAddTabConfig;
  /** Tab 栏前缀区域（dockview dv-pre-actions-container / prefixHeaderActions） */
  preActions?: ReactNode;
  /** 点击 tab 时回调；wasActive 为 true 表示点击的是当前已激活 tab */
  onTabClick?: (tabId: string, wasActive: boolean) => void;
  /** 布局变化时在 tab 栏右侧嵌入窗口拖拽区与控制按钮 */
  windowControl?: boolean;
  /** 当前 dock 内 panel 被跨 dockview 拖出后，通知业务 store 做迁出清理 */
  onPanelTransferredOut?: (panelId: string, targetScope: string) => void;
  /**
   * segment：模块分段 Tab（ModuleSegmentDock），单 group tab 栏固定含 drag-spacer。
   * default：按布局树解析顶部/右上角 group。
   */
  windowChromeVariant?: "default" | "segment";
  /** 窗口控制按钮左侧的额外操作按钮 */
  windowChromeLeftActions?: ReactNode;
  /** 使用 dockview 内置 DefaultTab（不注入自定义 DockTabHeader） */
  nativeTabs?: boolean;
  /** 禁用 tab 溢出折叠菜单（侧栏 tab 较少时建议开启） */
  disableTabsOverflowList?: boolean;
  /** tab 栏滚动条实现；侧栏竖排 tab 建议 native 避免 custom scrollable 裁切 */
  scrollbars?: "native" | "custom";
}

interface PanelParams {
  tabId: string;
  label?: string;
  icon?: DockHeaderIconKind;
  tooltip?: string;
  status?: TopbarTabDef["status"];
  /** 递增以触发 panel 内容重渲染（renderPanel 通过 ref 注入，需靠 params 变更通知 dockview） */
  contentRev?: number;
  /** 软刷新计数器：与 contentRev 不同，不参与 key，仅触发 reconcile 而非 remount */
  softRev?: number;
  type?: DockTabPageType;
  dirty?: boolean;
  saved?: boolean;
}

const COMPONENT_NAME = "dockable-content";

function isExternalPanelDrop(
  event: { getData: () => ReturnType<DockviewDidDropEvent["getData"]> },
  targetViewId: string,
): boolean {
  const data = event.getData();
  return Boolean(data?.panelId && data.viewId !== targetViewId);
}

function resolveExternalDropScopes(
  event: { getData: () => ReturnType<DockviewDidDropEvent["getData"]> },
  _targetViewId: string,
  _targetScope: string | undefined,
): { sourceScope: string | undefined } {
  const data = event.getData();
  if (!data?.viewId) return { sourceScope: undefined };
  const sourceScope = getDockviewInstance(data.viewId)?.scope;
  return { sourceScope };
}

function shouldInterceptExternalDrop(
  event: DockviewWillDropEvent,
  targetViewId: string,
  targetScope: string | undefined,
  api: DockviewApi,
  tabCount: number,
  acceptExternalDrops: boolean,
): boolean {
  if (!isExternalPanelDrop(event, targetViewId)) return false;
  const data = event.getData();
  const panelId = data?.panelId;
  const { sourceScope } = resolveExternalDropScopes(event, targetViewId, targetScope);
  if (shouldTransferModuleToWorkspace(targetScope, sourceScope)) {
    return true;
  }
  if (shouldTransferWorkspaceToModule(targetScope, sourceScope)) {
    return true;
  }
  // 兜底：工作区 payload panel 拖向模块 dock（sourceScope 偶发解析失败）
  if (panelId?.startsWith("ws-payload:") && isModuleDockScope(targetScope)) {
    return true;
  }
  if (event.kind === "edge") return true;
  return acceptExternalDrops && tabCount === 0 && api.panels.length === 0;
}

/** 无 panel 时保留空 group，供外部拖放落点或 tab 栏窗口控制 chrome */
function ensureEmptyDockGroup(api: DockviewApi): void {
  if (api.groups.length === 0) {
    api.addGroup();
  }
}

function keepEmptyDockMounted(
  acceptExternalDrops: boolean,
  windowControl: boolean,
): boolean {
  return acceptExternalDrops || windowControl;
}

export function DockableWorkspace({
  tabs,
  activeTabId,
  onActiveTabChange,
  onCloseTab,
  savedLayout,
  onSavedLayoutChange,
  renderPanel,
  panelContentKey = "default",
  softRefreshKey,
  panelContentKeysByTab,
  className,
  emptyContent,
  onTabContextMenu,
  onTabDoubleClick,
  createPanelRequest,
  dockScope,
  acceptExternalDrops = false,
  canAcceptExternalDrop,
  onExternalDrop,
  resolveTabGroupMeta,
  defaultHeaderPosition = "top",
  relayoutRef,
  enableTabGroups = true,
  tabStyle = "default",
  addTabConfig,
  preActions,
  onTabClick,
  windowControl = false,
  onPanelTransferredOut,
  windowChromeVariant = "default",
  windowChromeLeftActions,
  nativeTabs = false,
  disableTabsOverflowList = false,
  scrollbars,
}: DockableWorkspaceProps) {
  const [windowChromeHosts, setWindowChromeHosts] = useState<{
    dragGroupId: string | null;
    controlsGroupId: string | null;
  }>({ dragGroupId: null, controlsGroupId: null });
  const apiRef = useRef<DockviewApi | null>(null);
  const viewIdRef = useRef<string | null>(null);
  const transferredOutRef = useRef(new Set<string>());
  const layoutLoadedRef = useRef(false);
  const [layoutReady, setLayoutReady] = useState(false);
  const markLayoutReady = useCallback(() => {
    layoutLoadedRef.current = true;
    setLayoutReady(true);
  }, []);
  const isSyncingRef = useRef(false);
  /** 程序化 setActive 时不向上冒泡，避免与用户点击 Tab 冲突 */
  const isProgrammaticActiveRef = useRef(false);
  /** 程序化 setActive 的目标 panel id；onDidActivePanelChange 匹配到此 id 时消费事件并重置 */
  const pendingProgrammaticActiveRef = useRef<string | null>(null);
  /** 程序化 setActive 的兜底重置定时器（防止 dockview 不触发预期事件导致永久阻塞） */
  const programmaticActiveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSavedLayoutRef = useRef<SerializedDockview | null>(savedLayout);
  // 跟踪最近一次主动写回 store 的布局；useEffect 用它来识别"自己写回去"vs"外部变更"
  const lastWrittenLayoutRef = useRef<SerializedDockview | null>(null);
  // 标记 lastWrittenLayoutRef 是由 onDidActivePanelChange 同步设置的，
  // onDidLayoutChange（异步 microtask）应保留该引用，避免创建新对象导致引用不等
  const lastWrittenFromActiveRef = useRef(false);
  /** 拖拽/resize 期间合并 layout 写回，避免高频 localStorage persist */
  const pendingLayoutPersistRef = useRef<SerializedDockview | null>(null);
  const layoutPersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastStructureFingerprintRef = useRef<string | null>(null);
  /** 上一轮 effect 见到的 savedLayout prop；区分「始终 null」与「外部主动清空持久化布局」 */
  const prevSavedLayoutPropRef = useRef<SerializedDockview | null | undefined>(undefined);

  // 回调 ref —— 避免 children 重渲染
  const renderPanelRef = useRef(renderPanel);
  renderPanelRef.current = renderPanel;
  const panelContentKeyRef = useRef(panelContentKey);
  panelContentKeyRef.current = panelContentKey;
  const lastBumpedPanelContentKeyRef = useRef<string | null>(null);
  const lastBumpedSoftRefreshKeyRef = useRef<string | null>(null);
  const prevPanelContentKeysByTabRef = useRef<Record<string, string>>({});
  const onCloseTabRef = useRef(onCloseTab);
  onCloseTabRef.current = onCloseTab;
  const onActiveTabChangeRef = useRef(onActiveTabChange);
  onActiveTabChangeRef.current = onActiveTabChange;
  const onSavedLayoutChangeRef = useRef(onSavedLayoutChange);
  onSavedLayoutChangeRef.current = onSavedLayoutChange;
  const createPanelRequestRef = useRef(createPanelRequest);
  createPanelRequestRef.current = createPanelRequest;
  const dockScopeRef = useRef(dockScope);
  dockScopeRef.current = dockScope;
  const acceptExternalDropsRef = useRef(acceptExternalDrops);
  acceptExternalDropsRef.current = acceptExternalDrops;
  const canAcceptExternalDropRef = useRef(canAcceptExternalDrop);
  canAcceptExternalDropRef.current = canAcceptExternalDrop;
  const onExternalDropRef = useRef(onExternalDrop);
  onExternalDropRef.current = onExternalDrop;
  const onTabContextMenuRef = useRef(onTabContextMenu);
  onTabContextMenuRef.current = onTabContextMenu;
  const onTabDoubleClickRef = useRef(onTabDoubleClick);
  onTabDoubleClickRef.current = onTabDoubleClick;
  const onPanelTransferredOutRef = useRef(onPanelTransferredOut);
  onPanelTransferredOutRef.current = onPanelTransferredOut;

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const resolveTabGroupMetaRef = useRef(resolveTabGroupMeta);
  resolveTabGroupMetaRef.current = resolveTabGroupMeta;
  const defaultHeaderPositionRef = useRef(defaultHeaderPosition);
  defaultHeaderPositionRef.current = defaultHeaderPosition;
  const enableTabGroupsRef = useRef(enableTabGroups);
  enableTabGroupsRef.current = enableTabGroups;
  const windowControlRef = useRef(windowControl);
  windowControlRef.current = windowControl;
  const windowChromeVariantRef = useRef(windowChromeVariant);
  windowChromeVariantRef.current = windowChromeVariant;

  const windowChromeLeftActionsRef = useRef(windowChromeLeftActions);
  windowChromeLeftActionsRef.current = windowChromeLeftActions;

  const windowChromeHostsRef = useRef(windowChromeHosts);
  windowChromeHostsRef.current = windowChromeHosts;

  const syncWindowChromeHost = useCallback((api: DockviewApi) => {
    if (!windowControlRef.current) {
      setWindowChromeHosts((prev) =>
        prev.dragGroupId === null && prev.controlsGroupId === null
          ? prev
          : { dragGroupId: null, controlsGroupId: null },
      );
      return;
    }
    const raw = api.toJSON();
    const layout = normalizeDockLayout(raw) ?? raw;
    let next: { dragGroupId: string | null; controlsGroupId: string | null };

    if (windowChromeVariantRef.current === "segment") {
      const groupIds =
        api.groups.length > 0
          ? api.groups.map((g) => g.id)
          : (describeDockLayout(layout)?.groups.map((g) => g.id) ?? []);
      next = resolveSegmentWindowChromeHosts(groupIds);
    } else {
      const chrome = resolveDockWindowChromeLayout(
        layout,
        defaultHeaderPositionRef.current,
      );
      next = {
        dragGroupId: chrome?.dragGroupId ?? null,
        controlsGroupId: chrome?.controlsGroupId ?? null,
      };
    }
    setWindowChromeHosts((prev) =>
      prev.dragGroupId === next.dragGroupId &&
      prev.controlsGroupId === next.controlsGroupId
        ? prev
        : next,
    );
  }, []);

  const syncWindowChromeHostRef = useRef(syncWindowChromeHost);
  syncWindowChromeHostRef.current = syncWindowChromeHost;

  const tabStyleRef = useRef(tabStyle);
  tabStyleRef.current = tabStyle;
  const onTabClickRef = useRef(onTabClick);
  onTabClickRef.current = onTabClick;

  const tabHeaderRuntime = useMemo(
    (): DockTabHeaderRuntime => ({
      tabsRef,
      activeTabIdRef,
      tabStyleRef,
      onTabContextMenuRef,
      onTabDoubleClickRef,
      onTabClickRef,
    }),
    [],
  );
  const addTabConfigRef = useRef(addTabConfig);
  addTabConfigRef.current = addTabConfig;
  const preActionsRef = useRef(preActions);
  preActionsRef.current = preActions;

  /**
   * 程序化调用 panel.api.setActive() 的安全包装。
   * dockview 的 onDidActivePanelChange 是异步触发的（microtask / setTimeout），
   * 如果在 finally 中同步重置 isProgrammaticActiveRef，异步事件会绕过保护，
   * 导致 onActiveTabChange 被错误调用，形成 setActive → onDidActivePanelChange
   * → onActiveTabChange → activeTabId 变化 → sync effect → setActive 的反馈循环。
   *
   * 本函数设置目标 panel id，在 onDidActivePanelChange 中匹配到该 id 时消费事件并重置；
   * 同时启动 200ms 兜底定时器，防止 dockview 不触发预期事件导致永久阻塞。
   */
  const runProgrammaticActive = useCallback(
    (targetId: string, action: () => void) => {
      const dockActive = apiRef.current?.activePanel?.id;
      console.log(`[runProgActive] target=${targetId} dockActive=${dockActive} scope=${dockScopeRef.current} stack=${new Error().stack?.split('\n').slice(1,4).join(' | ')}`);
      if (dockActive === targetId) {
        console.log(`[runProgActive] SKIP (already active)`);
        return;
      }
      if (programmaticActiveTimerRef.current) {
        clearTimeout(programmaticActiveTimerRef.current);
      }
      pendingProgrammaticActiveRef.current = targetId;
      isProgrammaticActiveRef.current = true;
      try {
        action();
      } finally {
        if (isProgrammaticActiveRef.current) {
          programmaticActiveTimerRef.current = setTimeout(() => {
            console.log(`[runProgActive] TIMEOUT reset target=${targetId}`);
            pendingProgrammaticActiveRef.current = null;
            isProgrammaticActiveRef.current = false;
            programmaticActiveTimerRef.current = null;
          }, 200);
        }
      }
    },
    [],
  );

  const syncTabGroups = useCallback((api: DockviewApi, manageLock = true) => {
    if (manageLock) isSyncingRef.current = true;
    try {
      if (enableTabGroupsRef.current) {
        
        syncTabGroupsByPanelType(
          api,
          tabsRef.current,
          resolveTabGroupMetaRef.current,
        );
      } else {
        clearTabGroups(api);
      }
      syncGroupHeaderPosition(api, defaultHeaderPositionRef.current);
    } finally {
      if (manageLock) isSyncingRef.current = false;
    }
  }, []);

  const bumpPanelContentRev = useCallback((api: DockviewApi) => {
    console.log(`[bumpContentRev-all] scope=${dockScopeRef.current} tabs=${tabsRef.current.map(t=>t.id).join(',')} stack=${new Error().stack?.split('\n').slice(1,4).join(' | ')}`);
    isSyncingRef.current = true;
    try {
      for (const tab of tabsRef.current) {
        const panel = api.getPanel(tab.id);
        if (!panel) continue;
        const current = (panel.api.getParameters() ?? {}) as PanelParams;
        panel.api.updateParameters({
          ...current,
          contentRev: (current.contentRev ?? 0) + 1,
        });
      }
      lastBumpedPanelContentKeyRef.current = panelContentKeyRef.current;
    } finally {
      isSyncingRef.current = false;
    }
  }, []);

  const bumpPanelContentRevForTabIds = useCallback((api: DockviewApi, tabIds: string[]) => {
    if (tabIds.length === 0) return;
    console.log(`[bumpContentRev-tab] scope=${dockScopeRef.current} tabIds=${tabIds.join(',')} stack=${new Error().stack?.split('\n').slice(1,4).join(' | ')}`);
    isSyncingRef.current = true;
    try {
      for (const tabId of tabIds) {
        const panel = api.getPanel(tabId);
        if (!panel) continue;
        const current = (panel.api.getParameters() ?? {}) as PanelParams;
        panel.api.updateParameters({
          ...current,
          contentRev: (current.contentRev ?? 0) + 1,
        });
      }
    } finally {
      isSyncingRef.current = false;
    }
  }, []);

  const bumpPanelSoftRev = useCallback((api: DockviewApi) => {
    isSyncingRef.current = true;
    try {
      for (const tab of tabsRef.current) {
        const panel = api.getPanel(tab.id);
        if (!panel) continue;
        const current = (panel.api.getParameters() ?? {}) as PanelParams;
        panel.api.updateParameters({
          ...current,
          softRev: (current.softRev ?? 0) + 1,
        });
      }
    } finally {
      isSyncingRef.current = false;
    }
  }, []);

  // 单组件：所有 panel 共享一个 React 组件，渲染内容靠 params.tabId + contentRev
  // 注意：key 仅含 contentRev，softRev 变化时 reconcile 而非 remount
  const components = useMemo(
    () => ({
      [COMPONENT_NAME]: (props: IDockviewPanelProps<PanelParams>) => {
        const tabId = props.params.tabId;
        const contentRev = props.params.contentRev ?? 0;
        const isActive = props.containerApi?.activePanel?.id === tabId;
        console.log(`[panel-render] tabId=${tabId} rev=${contentRev} active=${isActive} scope=${dockScopeRef.current}`);
        useEffect(() => {
          console.log(`[panel-mount] tabId=${tabId} rev=${contentRev} active=${isActive} scope=${dockScopeRef.current} stack=${new Error().stack?.split('\n').slice(1,5).join(' | ')}`);
          return () => {
            console.log(`[panel-unmount] tabId=${tabId} rev=${contentRev} scope=${dockScopeRef.current}`);
          };
        }, [tabId, contentRev]);
        return (
          <div
            key={`${tabId}:${contentRev}`}
            className="dock-pane-surface"
            data-dock-tab-id={tabId}
          >
            {renderPanelRef.current(tabId)}
          </div>
        );
      },
    }),
    [],
  );

  // panelContentKey / panelContentKeysByTab 变更时 bump contentRev
  useEffect(() => {
    const api = apiRef.current;
    if (!api || !layoutLoadedRef.current || isSyncingRef.current) return;

    if (panelContentKeysByTab) {
      const prev = prevPanelContentKeysByTabRef.current;
      const changedTabIds: string[] = [];
      for (const tab of tabsRef.current) {
        const nextKey = panelContentKeysByTab[tab.id];
        if (nextKey === undefined) continue;
        if (prev[tab.id] !== nextKey) {
          changedTabIds.push(tab.id);
        }
      }
      prevPanelContentKeysByTabRef.current = { ...panelContentKeysByTab };
      if (changedTabIds.length > 0) {
        bumpPanelContentRevForTabIds(api, changedTabIds);
      }
      return;
    }

    if (lastBumpedPanelContentKeyRef.current === panelContentKey) return;
    lastBumpedPanelContentKeyRef.current = panelContentKey;
    bumpPanelContentRev(api);
  }, [panelContentKey, panelContentKeysByTab, layoutReady, bumpPanelContentRev, bumpPanelContentRevForTabIds]);

  // softRefreshKey 变更时 bump softRev（reconcile 而非 remount，保持嵌套 dock 状态）
  useEffect(() => {
    const api = apiRef.current;
    if (!api || !layoutLoadedRef.current || isSyncingRef.current) return;
    if (softRefreshKey === undefined) return;
    if (lastBumpedSoftRefreshKeyRef.current === softRefreshKey) return;
    lastBumpedSoftRefreshKeyRef.current = softRefreshKey;
    bumpPanelSoftRev(api);
  }, [softRefreshKey, layoutReady, bumpPanelSoftRev]);

  // 自定义 tab：元数据通过 panel params + DockWorkspaceTabHeader 内 liveMeta 同步
  const defaultTabComponent = nativeTabs ? undefined : DockWorkspaceTabHeader;

  const rightHeaderActions = useCallback(
    (props: IDockviewHeaderActionsProps) => {
      if (!windowControlRef.current) return null;
      const { dragGroupId, controlsGroupId } = windowChromeHostsRef.current;
      const groupId = props.group.id;
      const isDragHost = groupId === dragGroupId;
      const isControlsHost = groupId === controlsGroupId;
      if (!isDragHost && !isControlsHost) return null;

      let mode: DockWindowChromeMode;
      if (isControlsHost) {
        // 右上角：移动 + 窗口控制
        mode = "both";
      } else {
        // 占据顶部（非右上角）：仅移动
        mode = "drag";
      }
      return (
        <DockWindowChromeActions
          mode={mode}
          leftActions={windowChromeLeftActionsRef.current}
        />
      );
    },
    [windowChromeHosts],
  );

  // dockview DOM 顺序：prefixActions → tabs → leftActions → void → rightActions
  const prefixHeaderActions = useCallback(
    (_props: IDockviewHeaderActionsProps) => {
      const node = preActionsRef.current;
      if (!node) return null;
      return <div className="dock-prefix-actions">{node}</div>;
    },
    [],
  );

  // 「+」放在 leftActions，紧贴在 tabs 后面
  const leftHeaderActions = useCallback(
    (props: IDockviewHeaderActionsProps) => {
      const addCfg = addTabConfigRef.current;
      if (addCfg?.show && (addCfg.onAdd || (addCfg.menuItems?.length ?? 0) > 0)) {
        return (
          <TopbarTabAddButton
            title={addCfg.title}
            menuItems={addCfg.menuItems}
            onAdd={addCfg.onAdd}
            onMenuSelect={addCfg.onMenuSelect}
          />
        );
      }
      if (!createPanelRequestRef.current) return null;
      return (
        <button
          type="button"
          className="dock-panel-add-btn drag-ignore"
          onClick={(e) => {
            e.stopPropagation();
            const opts = createPanelRequestRef.current?.();
            if (!opts) return;
            const api = props.containerApi;
            const existing = api.getPanel(opts.id);
            if (existing) {
              existing.api.setActive();
              return;
            }
            const reference = props.activePanel ?? props.panels[0];
            const options: Parameters<DockviewApi["addPanel"]>[0] = {
              id: opts.id,
              component: COMPONENT_NAME,
              title: opts.title,
              params: { tabId: opts.id },
            };
            if (reference) {
              options.position = {
                referencePanel: reference.id,
                direction: "within",
              };
            }
            api.addPanel(options);
          }}
          title="新建面板"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden
          >
            <line x1="8" y1="3" x2="8" y2="13" />
            <line x1="3" y1="8" x2="13" y2="8" />
          </svg>
        </button>
      );
    },
    [],
  );

  // 自定义 tab 关闭按钮 drag-ignore；windowControl 时整段 Tab 栏标记 no-drag
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const isDockLayoutDragActive = useCallback(() => {
    const root = wrapperRef.current;
    if (!root) return false;
    return Boolean(
      root.querySelector(
        ".dv-tab-dragging, .dv-tab--dragging, .dv-resize-container-dragging",
      ),
    );
  }, []);

  const flushPendingLayoutPersist = useCallback(() => {
    if (layoutPersistTimerRef.current) {
      clearTimeout(layoutPersistTimerRef.current);
      layoutPersistTimerRef.current = null;
    }
    const next = pendingLayoutPersistRef.current;
    if (!next) return;
    pendingLayoutPersistRef.current = null;
    // 保持 lastWrittenLayoutRef 与 onSavedLayoutChange 传入的对象引用一致，
    // 避免 savedLayout effect 因引用不等而误调 fromJSON
    lastWrittenLayoutRef.current = next;
    onSavedLayoutChangeRef.current(next);
  }, []);

  const scheduleLayoutPersist = useCallback(
    (next: SerializedDockview, opts?: { preserveLastWritten?: boolean }) => {
      pendingLayoutPersistRef.current = next;
      if (!opts?.preserveLastWritten) {
        lastWrittenLayoutRef.current = next;
      }

      const fp = layoutStructureFingerprint(next);
      const activeOnly =
        lastStructureFingerprintRef.current !== null &&
        lastStructureFingerprintRef.current === fp;

      if (layoutPersistTimerRef.current) {
        clearTimeout(layoutPersistTimerRef.current);
      }

      const delay = isDockLayoutDragActive() ? 120 : activeOnly ? 1000 : 80;
      layoutPersistTimerRef.current = setTimeout(() => {
        layoutPersistTimerRef.current = null;
        if (isDockLayoutDragActive()) {
          scheduleLayoutPersist(pendingLayoutPersistRef.current ?? next);
          return;
        }
        if (!activeOnly && fp) {
          lastStructureFingerprintRef.current = fp;
        }
        flushPendingLayoutPersist();
      }, delay);
    },
    [flushPendingLayoutPersist, isDockLayoutDragActive],
  );

  useEffect(() => {
    return () => {
      if (layoutPersistTimerRef.current) {
        clearTimeout(layoutPersistTimerRef.current);
        layoutPersistTimerRef.current = null;
      }
      flushPendingLayoutPersist();
    };
  }, [flushPendingLayoutPersist]);
  const { active: moduleActive } = useModuleVisibility();
  const moduleActiveRef = useRef(moduleActive);
  moduleActiveRef.current = moduleActive;
  const syncStatusBarActiveDockRef = useRef<(panelId: string | null) => void>(() => {});
  syncStatusBarActiveDockRef.current = (panelId) => {
    const tab = panelId ? tabsRef.current.find((item) => item.id === panelId) : undefined;
    publishStatusBarActiveDock(
      dockScopeRef.current,
      panelId,
      tab ? { panelType: tab.panelType, label: tab.label } : undefined,
      moduleActiveRef.current,
    );
  };
  const wasHiddenRef = useRef(true);
  const lastMeasuredRef = useRef({ w: 0, h: 0 });

  const relayoutFromContainer = useCallback(() => {
    const api = apiRef.current;
    const wrapper = wrapperRef.current;
    const dockRoot = wrapper?.querySelector<HTMLElement>(
      ".dockable-workspace__dockview",
    );
    if (!api || !layoutLoadedRef.current || !dockRoot || !wrapper) return;

    const w = dockRoot.clientWidth;
    const h = dockRoot.clientHeight;
    const headerPos = defaultHeaderPositionRef.current;
    const minLayoutW =
      headerPos === "top" ? TOP_HEADER_MIN_LAYOUT_PX : SIDE_HEADER_MIN_LAYOUT_PX;

    if (w <= 0 || h <= 0) {
      wasHiddenRef.current = true;
      lastMeasuredRef.current = { w: 0, h: 0 };
      return;
    }

    // 容器尚未展开到可用宽度：跳过 layout，保留上次正确布局，等下一帧再量
    if (w < minLayoutW) {
      wasHiddenRef.current = true;
      return;
    }

    const recovering =
      wasHiddenRef.current ||
      (lastMeasuredRef.current.w < minLayoutW && w >= minLayoutW);
    wasHiddenRef.current = false;
    lastMeasuredRef.current = { w, h };

    if (headerPos !== "top") {
      syncGroupHeaderPosition(api, headerPos);
    }

    if (recovering) {
      wrapper.classList.add("dockable-workspace--recovering");
    }

    api.layout(w, h, true);

    if (recovering) {
      requestAnimationFrame(() => {
        wrapper.classList.remove("dockable-workspace--recovering");
        const nextW = dockRoot.clientWidth;
        const nextH = dockRoot.clientHeight;
        if (
          apiRef.current &&
          layoutLoadedRef.current &&
          nextW >= minLayoutW &&
          nextH > 0
        ) {
          apiRef.current.layout(nextW, nextH, true);
        }
      });
    }
  }, []);

  const pressedActiveTabIdRef = useRef<string | null>(null);
  useEffect(() => {
    const root = wrapperRef.current;
    if (!root) return;
    const handle = () => {
      root
        .querySelectorAll<HTMLElement>(".dv-default-tab .dv-default-tab-action")
        .forEach((el: HTMLElement) => el.classList.add("drag-ignore"));
      if (windowControl) {
        root.querySelectorAll<HTMLElement>(DOCK_TAB_NO_DRAG_SELECTOR).forEach((el) => {
          el.setAttribute("data-tauri-drag-region", "false");
        });
      }
    };
    handle();
    const observer = new MutationObserver(handle);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [tabs.length, windowControl]);

  // windowControl：void 标记 no-drag（不含嵌套 DockableWorkspace）
  useEffect(() => {
    const root = wrapperRef.current;
    if (!root) return;

    const syncVoids = () => {
      root.querySelectorAll<HTMLElement>(".dv-void-container").forEach((el) => {
        if (el.closest(".dockable-workspace") !== root) return;
        if (windowControl) {
          el.setAttribute("data-tauri-drag-region", "false");
          el.classList.add("dock-window-void-drag");
        } else {
          el.removeAttribute("data-tauri-drag-region");
          el.classList.remove("dock-window-void-drag");
        }
      });
    };

    syncVoids();
    const observer = new MutationObserver(syncVoids);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [windowControl, tabs.length, layoutReady]);

  // windowControl：Tab 栏空白区 JS 移窗 + 双击最大化
  useEffect(() => {
    const root = wrapperRef.current;
    if (!root || !windowControl) return;

    const dragRef: { current: { startX: number; startY: number } | null } = { current: null };
    const lastTapRef: {
      current: { time: number; x: number; y: number } | null;
    } = { current: null };

    const isVoidTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      const voidEl = target.closest(".dv-void-container.dock-window-void-drag");
      return Boolean(voidEl && root.contains(voidEl));
    };

    const tryToggleMaximizeFromDoubleTap = (event: PointerEvent | MouseEvent) => {
      const now = Date.now();
      const last = lastTapRef.current;
      if (
        !last ||
        now - last.time > VOID_DOUBLE_CLICK_MS ||
        Math.abs(event.clientX - last.x) > VOID_DOUBLE_CLICK_DISTANCE_PX ||
        Math.abs(event.clientY - last.y) > VOID_DOUBLE_CLICK_DISTANCE_PX
      ) {
        return false;
      }
      lastTapRef.current = null;
      dragRef.current = null;
      event.preventDefault();
      event.stopPropagation();
      void toggleDockWindowMaximize();
      return true;
    };

    const onTabBarPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      if (!findTabBarChromeTarget(root, event.target)) return;

      if (tryToggleMaximizeFromDoubleTap(event)) {
        if (isVoidTarget(event.target)) {
          event.stopImmediatePropagation();
        }
        return;
      }

      lastTapRef.current = { time: Date.now(), x: event.clientX, y: event.clientY };

      if (isVoidTarget(event.target) && !event.shiftKey) {
        event.stopImmediatePropagation();
        dragRef.current = { startX: event.clientX, startY: event.clientY };
      }
    };

    const onTabBarClick = (event: MouseEvent) => {
      if (event.detail !== 2) return;
      if (!findTabBarChromeTarget(root, event.target)) return;
      lastTapRef.current = null;
      dragRef.current = null;
      event.preventDefault();
      event.stopPropagation();
      void toggleDockWindowMaximize();
    };

    const onPointerMove = (event: PointerEvent) => {
      const start = dragRef.current;
      if (!start) return;
      if (
        Math.abs(event.clientX - start.startX) > VOID_WINDOW_DRAG_THRESHOLD_PX ||
        Math.abs(event.clientY - start.startY) > VOID_WINDOW_DRAG_THRESHOLD_PX
      ) {
        dragRef.current = null;
        void getCurrentWindow().startDragging();
      }
    };

    const clearDrag = () => {
      dragRef.current = null;
    };

    root.addEventListener("pointerdown", onTabBarPointerDown, true);
    root.addEventListener("click", onTabBarClick, true);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", clearDrag);
    window.addEventListener("pointercancel", clearDrag);
    return () => {
      root.removeEventListener("pointerdown", onTabBarPointerDown, true);
      root.removeEventListener("click", onTabBarClick, true);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", clearDrag);
      window.removeEventListener("pointercancel", clearDrag);
    };
  }, [windowControl, tabs.length, layoutReady]);

  // 半屏 → 全屏时 windowControl 由 false 变 true：须重新解析 chrome 宿主并刷新 tab 栏右侧槽位
  useEffect(() => {
    const api = apiRef.current;
    if (!api || !layoutLoadedRef.current) return;
    syncWindowChromeHostRef.current(api);
    if (!windowControl) return;

    const root = wrapperRef.current?.querySelector<HTMLElement>(
      ".dockable-workspace__dockview",
    );
    if (!root) return;

    const relayout = () => {
      const w = root.clientWidth;
      const h = root.clientHeight;
      if (w > 0 && h > 0) api.layout(w, h, true);
    };
    relayout();
    const raf = requestAnimationFrame(relayout);
    return () => cancelAnimationFrame(raf);
  }, [windowControl, windowChromeHosts, layoutReady]);

  // 再次点击已激活 tab：以 pointerdown 时的激活态为准。
  // dockview 会在 click 前完成切换，若只看 click 时的 dv-active-tab，
  // 点击其它 tab 也会被误判为“当前激活 tab”。
  useEffect(() => {
    if (!onTabClick) return;
    const root = wrapperRef.current;
    if (!root) return;

    const findTabHeader = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return null;
      const tabHeader = target.closest<HTMLElement>(
        ".dv-default-tab[data-dock-tab-id]",
      );
      return tabHeader && root.contains(tabHeader) ? tabHeader : null;
    };

    const onCapturePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const tabHeader = findTabHeader(event.target);
      if (!tabHeader) return;
      const tab = tabHeader.closest(".dv-tab");
      const tabId = tabHeader.dataset.dockTabId;
      pressedActiveTabIdRef.current =
        tabId && tab?.classList.contains("dv-active-tab") ? tabId : null;
    };

    const onCaptureClick = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const tabHeader = findTabHeader(event.target);
      const tabId = tabHeader?.dataset.dockTabId;
      if (!tabId || pressedActiveTabIdRef.current !== tabId) {
        pressedActiveTabIdRef.current = null;
        return;
      }
      pressedActiveTabIdRef.current = null;
      // 不 stopPropagation：点击已激活 tab 时 dockview 本就不会切换，
      // 无需阻止其默认行为。stopPropagation 会在 dockview pointerdown
      // 先于 capture 监听器执行时误阻正常 tab 切换。
      onTabClickRef.current?.(tabId, true);
    };

    root.addEventListener("pointerdown", onCapturePointerDown, true);
    root.addEventListener("click", onCaptureClick, true);
    return () => {
      root.removeEventListener("pointerdown", onCapturePointerDown, true);
      root.removeEventListener("click", onCaptureClick, true);
    };
  }, [onTabClick, tabs.length]);

  // 工程工作区 dock：pointerdown 时广播 tab 抓取，供跨窗口拖拽桥接
  useEffect(() => {
    if (!dockScope?.startsWith("workspace-bottom-")) return;
    const root = wrapperRef.current;
    if (!root) return;

    const onGrab = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const tabHeader = target.closest<HTMLElement>(".dv-default-tab[data-dock-tab-id]");
      const panelId = tabHeader?.dataset.dockTabId;
      if (!panelId) return;
      window.dispatchEvent(
        new CustomEvent("omnipanel:workspace-dock-tab-grab", {
          detail: {
            panelId,
            dockScope,
            screenX: event.screenX,
            screenY: event.screenY,
          },
        }),
      );
    };

    root.addEventListener("pointerdown", onGrab, true);
    return () => root.removeEventListener("pointerdown", onGrab, true);
  }, [dockScope, tabs.length]);

  // 终端/数据库等模块 dock：pointerdown 时广播 tab 抓取，供模块→工作区拖拽桥接
  useEffect(() => {
    if (!dockScope || dockScope.startsWith("workspace-bottom-")) return;
    // 子 dock（终端侧栏、服务器详情、仪表盘）不参与跨窗口拖拽，
    // 它们的 tab 点击应走 dockview 原生切换，不应触发 grab → pointermove/pointerup 拦截。
    if (dockScope.startsWith("terminal-side-")) return;
    if (dockScope.startsWith("server-detail-")) return;
    if (dockScope === "dashboard") return;
    const root = wrapperRef.current;
    if (!root) return;

    const onGrab = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const tabHeader = target.closest<HTMLElement>(".dv-default-tab[data-dock-tab-id]");
      const panelId = tabHeader?.dataset.dockTabId;
      if (!panelId) return;
      window.dispatchEvent(
        new CustomEvent("omnipanel:module-dock-tab-grab", {
          detail: {
            panelId,
            dockScope,
            screenX: event.screenX,
            screenY: event.screenY,
          },
        }),
      );
    };

    root.addEventListener("pointerdown", onGrab, true);
    return () => root.removeEventListener("pointerdown", onGrab, true);
  }, [dockScope, tabs.length]);

  // Tab 双击：拦截冒泡，避免触发无边框窗口 drag-region 最大化；具体行为由 onTabDoubleClick 决定
  useEffect(() => {
    const root = wrapperRef.current;
    if (!root) return;

    const findTabHeader = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return null;
      const tabHeader = target.closest<HTMLElement>(
        ".dv-default-tab[data-dock-tab-id]",
      );
      return tabHeader && root.contains(tabHeader) ? tabHeader : null;
    };

    const onCaptureDoubleClick = (event: MouseEvent) => {
      const tabHeader = findTabHeader(event.target);
      const tabId = tabHeader?.dataset.dockTabId;
      if (!tabId) return;
      event.preventDefault();
      event.stopPropagation();
      onTabDoubleClickRef.current?.(tabId);
    };

    root.addEventListener("dblclick", onCaptureDoubleClick, true);
    return () => {
      root.removeEventListener("dblclick", onCaptureDoubleClick, true);
    };
  }, [tabs.length]);

  // 加载初始布局（在 onReady 中执行）
  const applyInitialLayout = useCallback((api: DockviewApi) => {
    if (
      tabsRef.current.length === 0 &&
      (acceptExternalDropsRef.current || windowControlRef.current)
    ) {
      for (const panel of [...api.panels]) {
        api.removePanel(panel);
      }
      ensureEmptyDockGroup(api);
      markLayoutReady();
      syncWindowChromeHostRef.current(api);
      return;
    }

    const pending = pendingSavedLayoutRef.current;
    const desired = mergePanelsIntoLayout(pending, tabsRef.current.map((t) => t.id), "");
    if (desired) {
      // 二次校验：mergePanelsIntoLayout 通过只能说明 panel↔view 数量一致，
      // 不代表 dockview 的 _deserializer.fromJSON 一定能消化（外部脏数据
      // 可能在 panel 字典里塞入非法的 contentComponent / params 等）。这里
      // 再加一层白名单检查 + try/catch 兜底；任何失败都把 api 完全清空，
      // 让后续 addPanel 兜底路径接管。
      const normalized = normalizeDockLayout(desired) ?? desired;
      if (!isLayoutUsable(normalized)) {
        pendingSavedLayoutRef.current = null;
        onSavedLayoutChangeRef.current(null);
        try {
          api.clear();
        } catch {
          // 忽略：清空失败时下面的 addPanel 路径仍会重建
        }
      } else {
        try {
          api.fromJSON(normalized);
        } catch (err) {
          console.warn("[DockableWorkspace] fromJSON failed, resetting", err);
          pendingSavedLayoutRef.current = null;
          onSavedLayoutChangeRef.current(null);
          try {
            api.clear();
          } catch {
            // 忽略
          }
        }
      }
    }
    // 兜底：mergePanelsIntoLayout 应已生成完整布局；若 dockview 仍缺 panel，则补齐
    const existing = new Set(api.panels.map((p) => p.id));
    const allTabsPresent =
      tabsRef.current.length > 0 &&
      tabsRef.current.every((tab) => existing.has(tab.id));
    if (allTabsPresent && existing.size === tabsRef.current.length) {
      isSyncingRef.current = true;
      try {
        for (const tab of tabsRef.current) {
          syncPanelTabParams(api, tab);
        }
      } finally {
        isSyncingRef.current = false;
      }
      markLayoutReady();
      syncTabGroups(api);
      if (acceptExternalDropsRef.current) {
        ensureEmptyDockGroup(api);
      }
      bumpPanelContentRev(api);
      syncWindowChromeHostRef.current(api);
      return;
    }
    isSyncingRef.current = true;
    try {
      for (const tab of tabsRef.current) {
        if (existing.has(tab.id)) {
          syncPanelTabParams(api, tab);
          continue;
        }
        try {
          const firstPanel = api.panels[0];
          const options: Parameters<typeof api.addPanel>[0] = {
            id: tab.id,
            component: COMPONENT_NAME,
            params: tabParamsFromDockableTab(tab),
            title: tab.label,
            inactive: tab.id !== activeTabIdRef.current,
          };
          if (firstPanel) {
            options.position = {
              referencePanel: firstPanel.id,
              direction: "within",
            };
          }
          api.addPanel(options);
          syncPanelTabParams(api, tab);
          existing.add(tab.id);
        } catch (err) {
          // 防御性兜底：dockview 抛 "panel already exists" 时跳过
          console.warn("[DockableWorkspace] addPanel failed for", tab.id, err);
        }
      }
    } finally {
      isSyncingRef.current = false;
    }
    markLayoutReady();
    syncTabGroups(api);
    if (acceptExternalDropsRef.current) {
      ensureEmptyDockGroup(api);
    }
    bumpPanelContentRev(api);
    syncWindowChromeHostRef.current(api);
    // 布局还原后仍可能缺 panel（持久化布局损坏等），按 tabs 再补一轮
    if (tabsRef.current.length > 0) {
      const existingAfterLoad = new Set(api.panels.map((p) => p.id));
      for (const tab of tabsRef.current) {
        if (existingAfterLoad.has(tab.id)) continue;
        try {
          const firstPanel = api.panels[0];
          const options: Parameters<typeof api.addPanel>[0] = {
            id: tab.id,
            component: COMPONENT_NAME,
            params: tabParamsFromDockableTab(tab),
            title: tab.label,
            inactive: tab.id !== activeTabIdRef.current,
          };
          if (firstPanel) {
            options.position = {
              referencePanel: firstPanel.id,
              direction: "within",
            };
          }
          api.addPanel(options);
          syncPanelTabParams(api, tab);
          existingAfterLoad.add(tab.id);
        } catch (err) {
          console.warn("[DockableWorkspace] ensure panel after initial layout failed for", tab.id, err);
        }
      }
      syncTabGroups(api);
    }
  }, [syncTabGroups, bumpPanelContentRev, markLayoutReady]);

  /** 将 tabs 元数据同步到 dockview api（布局被 clear 后亦需调用以恢复 panel） */
  const syncTabsToApi = useCallback(
    (api: DockviewApi) => {
      const currentTabs = tabsRef.current;
      console.log(`[syncTabsToApi] enter tabs=${currentTabs.map(t=>t.id).join(',')} panels=${api.panels.map(p=>p.id).join(',')} active=${api.activePanel?.id} scope=${dockScopeRef.current}`);
      const persistLayoutFromApi = () => {
        if (!layoutLoadedRef.current) return;
        const raw = api.toJSON();
        const normalized = normalizeDockLayout(raw) ?? raw;
        const next = enrichLayoutWithTabMeta(normalized, tabsRef.current);
        lastWrittenLayoutRef.current = next;
        onSavedLayoutChangeRef.current(next);
      };
      const persistEmptyLayout = () => {
        if (!layoutLoadedRef.current) return;
        lastWrittenLayoutRef.current = null;
        onSavedLayoutChangeRef.current(null);
      };

      if (currentTabs.length === 0) {
        isSyncingRef.current = true;
        try {
          if (api.panels.length > 0) {
            if (
              acceptExternalDropsRef.current ||
              windowControlRef.current
            ) {
              for (const panel of [...api.panels]) {
                try {
                  api.removePanel(panel);
                } catch {
                  // panel 可能已被 clear 释放
                }
              }
              ensureEmptyDockGroup(api);
            } else {
              try {
                api.clear();
              } catch {
                // 忽略重复 clear 导致的 disposed 错误
              }
            }
          } else if (windowControlRef.current || acceptExternalDropsRef.current) {
            ensureEmptyDockGroup(api);
          }
          persistEmptyLayout();
        } finally {
          isSyncingRef.current = false;
          syncWindowChromeHostRef.current(api);
        }
        return;
      }
      isSyncingRef.current = true;
      let layoutChanged = false;
      try {
        const desiredIds = new Set(currentTabs.map((t) => t.id));
        const scopePrefix = dockScopeRef.current ? `${dockScopeRef.current}:` : null;
        for (const panel of [...api.panels]) {
          if (!desiredIds.has(panel.id)) {
            if (
              acceptExternalDropsRef.current &&
              scopePrefix &&
              panel.id.startsWith(scopePrefix)
            ) {
              continue;
            }
            try {
              console.log(`[syncTabsToApi] removePanel ${panel.id} scope=${dockScopeRef.current}`);
              api.removePanel(panel);
            } catch {
              // panel 可能已被 clear / unmount 释放
            }
            layoutChanged = true;
          }
        }
        const existing = new Set(api.panels.map((p) => p.id));
        for (const tab of currentTabs) {
          if (!existing.has(tab.id)) {
            const firstPanel = api.panels.find((p) => desiredIds.has(p.id));
            const options: Parameters<typeof api.addPanel>[0] = {
              id: tab.id,
              component: COMPONENT_NAME,
              params: tabParamsFromDockableTab(tab),
              title: tab.label,
              inactive: tab.id !== activeTabIdRef.current,
            };
            if (firstPanel) {
              options.position = {
                referencePanel: firstPanel.id,
                direction: "within",
              };
            }
            console.log(`[syncTabsToApi] addPanel ${tab.id} scope=${dockScopeRef.current}`);
            api.addPanel(options);
            syncPanelTabParams(api, tab);
            layoutChanged = true;
          } else {
            syncPanelTabParams(api, tab);
          }
        }
        const tabIds = currentTabs.map((tab) => tab.id);
        const panelOrder = api.groups.flatMap((group) => group.panels.map((panel) => panel.id));
        const expectedOrder = tabIds.filter((id) => panelOrder.includes(id));
        const actualOrder = panelOrder.filter((id) => tabIds.includes(id));
        if (actualOrder.join("\0") !== expectedOrder.join("\0")) {
          console.log(`[syncTabsToApi] REORDER expected=[${expectedOrder.join(',')}] actual=[${actualOrder.join(',')}] scope=${dockScopeRef.current}`);
          try {
            const raw = api.toJSON();
            const normalized = normalizeDockLayout(raw) ?? raw;
            const reordered = reorderLayoutViews(normalized, tabIds);
            api.fromJSON(enrichLayoutWithTabMeta(reordered, currentTabs));
            layoutChanged = true;
          } catch (err) {
            console.warn("[DockableWorkspace] reorder tabs failed", err);
          }
        }
        syncTabGroups(api, false);
      } finally {
        isSyncingRef.current = false;
        syncWindowChromeHostRef.current(api);
        if (layoutChanged) {
          console.log(`[syncTabsToApi] layoutChanged=true -> persistLayoutFromApi scope=${dockScopeRef.current}`);
          persistLayoutFromApi();
        }
      }
    },
    [syncTabGroups],
  );

  // 同步 tab 变更（添加/删除/重命名）；使用 useEffect 避免 layout 阶段 emit 触发 useSyncExternalStore 嵌套更新
  useEffect(() => {
    publishDockTabMeta(tabs);
  }, [tabs]);

  // 同步 tab 栏隐藏（兜底：Tab 头未挂载 hook 时仍按 tabBarHidden 隐藏标签）
  useLayoutEffect(() => {
    const root = wrapperRef.current;
    if (!root) return;
    const dockRoot =
      root.querySelector<HTMLElement>(".dockable-workspace__dockview") ?? root;
    const hiddenIds = new Set(
      tabs.filter((tab) => tab.tabBarHidden).map((tab) => tab.id),
    );
    dockRoot
      .querySelectorAll<HTMLElement>(".dv-default-tab[data-dock-tab-id]")
      .forEach((header) => {
        const id = header.dataset.dockTabId;
        if (!id) return;
        const tabEl = header.closest(".dv-tab");
        if (!tabEl) return;
        tabEl.classList.toggle("dock-tab--bar-hidden", hiddenIds.has(id));
        tabEl.setAttribute("data-tab-id", id);
      });
  }, [tabs]);

  const tabIdsKey = useMemo(() => tabs.map((tab) => tab.id).join("\0"), [tabs]);

  // 仅 meta 变更（label / preview / dirty 等）：layout 阶段同步 panel params，Tab 头早一帧更新
  useLayoutEffect(() => {
    const api = apiRef.current;
    if (!api || !layoutLoadedRef.current) {
      return;
    }
    for (const tab of tabs) {
      syncPanelTabParams(api, tab);
    }
  }, [tabs]);

  // 无 tab 且未保留 dockview 挂载时，DockviewReact 会卸载；须重置 api/布局状态，
  // 避免 tabs 再次增加时 syncTabsToApi 误用已 disposed 的 apiRef。
  useLayoutEffect(() => {
    if (
      tabs.length === 0 &&
      !keepEmptyDockMounted(acceptExternalDrops, windowControl)
    ) {
      for (const d of disposablesRef.current) d.dispose();
      disposablesRef.current = [];
      if (viewIdRef.current) {
        unregisterDockviewInstance(viewIdRef.current);
        viewIdRef.current = null;
      }
      apiRef.current = null;
      layoutLoadedRef.current = false;
      setLayoutReady(false);
    }
  }, [tabs.length, acceptExternalDrops, windowControl]);

  useEffect(() => {
    const api = apiRef.current;
    if (!api || !layoutLoadedRef.current) return;
    syncTabsToApi(api);
  }, [tabIdsKey, syncTabsToApi]);

  useEffect(() => {
    const scope = dockScopeRef.current;
    if (!scope) return;
    const onResync = (event: Event) => {
      const detail = (event as CustomEvent<{ scope?: string }>).detail;
      if (detail?.scope !== scope) return;
      const api = apiRef.current;
      if (!api || !layoutLoadedRef.current) return;
      syncTabsToApi(api);
    };
    window.addEventListener(DOCK_SCOPE_RESYNC_EVENT, onResync);
    return () => window.removeEventListener(DOCK_SCOPE_RESYNC_EVENT, onResync);
  }, [syncTabsToApi]);

  // 侧栏 header 等非常规方位：布局就绪后强制同步 group 方位并触发一次 layout，
  // 避免 custom scrollable + overflow 检测把 tab 全部收进底部折叠菜单。
  useLayoutEffect(() => {
    const api = apiRef.current;
    const root = wrapperRef.current?.querySelector<HTMLElement>(
      ".dockable-workspace__dockview",
    );
    if (!api || !layoutLoadedRef.current || !root) return;
    if (defaultHeaderPosition === "top") return;
    syncGroupHeaderPosition(api, defaultHeaderPosition);
    // 仅在容器有真实尺寸时 relayout；隐藏路由下 clientWidth/Height 为 0，
    // 用 0 调 api.layout 会把整个 dock（含侧栏 tab）压扁成不可见。
    const relayout = () => {
      const w = root.clientWidth;
      const h = root.clientHeight;
      if (w > 0 && h > 0) api.layout(w, h);
    };
    relayout();
    requestAnimationFrame(() => {
      relayout();
    });
  }, [layoutReady, defaultHeaderPosition]);

  // 模块路由 / 父容器从 display:none 恢复可见：绘制前同步 relayout
  useLayoutEffect(() => {
    if (!moduleActive) {
      const wrapper = wrapperRef.current;
      const dockRoot = wrapper?.querySelector<HTMLElement>(
        ".dockable-workspace__dockview",
      );
      if (dockRoot) {
        const headerPos = defaultHeaderPositionRef.current;
        const minLayoutW =
          headerPos === "top" ? TOP_HEADER_MIN_LAYOUT_PX : SIDE_HEADER_MIN_LAYOUT_PX;
        const w = dockRoot.clientWidth;
        const h = dockRoot.clientHeight;
        // 叠层路由仅切 visibility，容器仍全尺寸：勿误标 hidden，避免切回闪 recovering
        if (w >= minLayoutW && h > 0) {
          return;
        }
      }
      wasHiddenRef.current = true;
      return;
    }
    if (!layoutReady) return;
    const wrapper = wrapperRef.current;
    const dockRoot = wrapper?.querySelector<HTMLElement>(
      ".dockable-workspace__dockview",
    );
    // 叠层保活切回：尺寸未变且未经历 hidden 时跳过 layout，避免 recovering 闪帧
    if (!wasHiddenRef.current && dockRoot) {
      const w = dockRoot.clientWidth;
      const h = dockRoot.clientHeight;
      if (
        w > 0 &&
        h > 0 &&
        w === lastMeasuredRef.current.w &&
        h === lastMeasuredRef.current.h
      ) {
        return;
      }
    }
    relayoutFromContainer();
  }, [moduleActive, layoutReady, relayoutFromContainer]);

  // 同步重排入口：外层在改变 dock 宽度后、paint 前手动触发，消除异步重排的错位帧。
  useEffect(() => {
    if (!relayoutRef) return;
    relayoutRef.current = relayoutFromContainer;
    return () => {
      if (relayoutRef.current === relayoutFromContainer) relayoutRef.current = null;
    };
  }, [relayoutRef, relayoutFromContainer]);

  // 容器尺寸变化时（侧栏展开、工作区高度变化）重新 layout
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const dockRoot = wrapper.querySelector<HTMLElement>(
      ".dockable-workspace__dockview",
    );
    if (!dockRoot) return;

    const observer = new ResizeObserver(() => {
      relayoutFromContainer();
    });
    observer.observe(dockRoot);
    relayoutFromContainer();

    return () => observer.disconnect();
  }, [layoutReady, relayoutFromContainer]);

  // 同步 activeTabId
  useEffect(() => {
    const api = apiRef.current;
    if (!api || !layoutLoadedRef.current) return;
    if (!activeTabId) return;
    if (!tabs.some((t) => t.id === activeTabId)) return;
    const dockActive = api.activePanel?.id;
    console.log(`[sync-effect] activeTabId=${activeTabId} dockActive=${dockActive} isProg=${isProgrammaticActiveRef.current} scope=${dockScopeRef.current}`);
    const panel = api.getPanel(activeTabId);
    if (panel && dockActive !== activeTabId) {
      console.log(`[sync-effect] -> runProgrammaticActive(${activeTabId})`);
      runProgrammaticActive(activeTabId, () => {
        panel.api.setActive();
      });
    }
    syncStatusBarActiveDockRef.current(activeTabId);
  }, [activeTabId, tabs, runProgrammaticActive]);

  // 接收外部 savedLayout 变化（如 store 重置）
  // 关键：dockview 的 onDidLayoutChange 通过 queueMicrotask 异步触发，
  // 因此 isSyncingRef 已经在 finally 里清掉，handler 必然执行并写回 store。
  // 这里用 lastWrittenLayoutRef 识别"自己刚写回的对象"，避免无限 fromJSON→toJSON 循环。
  useEffect(() => {
    pendingSavedLayoutRef.current = savedLayout;
    if (!apiRef.current || !layoutLoadedRef.current) return;
    if (savedLayout && savedLayout === lastWrittenLayoutRef.current) return;

    const api = apiRef.current;
    const tabIds = tabsRef.current.map((t) => t.id);
    const apiPanelIds = new Set(api.panels.map((p) => p.id));
    if (savedLayout && tabIds.some((id) => apiPanelIds.has(id) && !collectPanelIds(savedLayout).has(id))) {
      // store 布局滞后于 api（如跨实例拖入刚完成），跳过陈旧 fromJSON
      return;
    }

    let needsPanelResync = false;
    if (savedLayout) {
      const normalized = normalizeDockLayout(savedLayout) ?? savedLayout;
      if (!isLayoutUsable(normalized)) {
        pendingSavedLayoutRef.current = null;
        onSavedLayoutChangeRef.current(null);
        try {
          apiRef.current.clear();
          needsPanelResync = true;
        } catch {
          // 忽略
        }
      } else {
        try {
          isSyncingRef.current = true;
          apiRef.current.fromJSON(normalized);
          syncTabsToApi(apiRef.current);
        } catch (err) {
          console.warn("[DockableWorkspace] fromJSON (savedLayout) failed, resetting", err);
          pendingSavedLayoutRef.current = null;
          onSavedLayoutChangeRef.current(null);
          try {
            apiRef.current.clear();
            needsPanelResync = true;
          } catch {
            // 忽略
          }
        } finally {
          isSyncingRef.current = false;
        }
      }
    } else {
      // savedLayout 为 null 时：仅当外部曾传入非 null 布局再置 null 才清空。
      // 避免 onReady 已创建默认面板后，本 effect 因 savedLayout 恒为 null 误调 clear()。
      const prevProp = prevSavedLayoutPropRef.current;
      if (prevProp !== undefined && prevProp !== null && apiRef.current.panels.length > 0) {
        try {
          apiRef.current.clear();
          needsPanelResync = true;
        } catch {
          // 忽略重复 clear 导致的 disposed 错误
        }
      }
    }
    prevSavedLayoutPropRef.current = savedLayout;
    lastWrittenLayoutRef.current = savedLayout;
    if (apiRef.current) {
      syncTabGroups(apiRef.current);
      if (needsPanelResync) {
        syncTabsToApi(apiRef.current);
      }
    }
  }, [savedLayout, syncTabGroups, syncTabsToApi]);

  const disposablesRef = useRef<Array<{ dispose: () => void }>>([]);

  // 注册 dockview 事件
  const handleReady = useCallback(
    (event: DockviewReadyEvent) => {
      const api = event.api;
      apiRef.current = api;

      // 避免 onReady 重复触发时重复订阅
      for (const d of disposablesRef.current) d.dispose();
      disposablesRef.current = [];

      const layoutDisposable = api.onDidLayoutChange(() => {
        console.log(`[onDidLayoutChange] isSyncing=${isSyncingRef.current} layoutLoaded=${layoutLoadedRef.current} active=${api.activePanel?.id} scope=${dockScopeRef.current}`);
        syncWindowChromeHostRef.current(apiRef.current ?? api);
        if (isSyncingRef.current || !layoutLoadedRef.current) return;
        const raw = api.toJSON();
        const normalized = normalizeDockLayout(raw) ?? raw;
        const next = enrichLayoutWithTabMeta(normalized, tabsRef.current);
        if (lastWrittenFromActiveRef.current) {
          // onDidActivePanelChange 已同步捕获并持久化此布局变化，
          // 保留 lastWrittenLayoutRef 引用（避免新对象导致引用不等），
          // 仅调度延迟 persist 供需要 localStorage 持久化的父组件使用
          lastWrittenFromActiveRef.current = false;
          scheduleLayoutPersist(next, { preserveLastWritten: true });
        } else {
          lastWrittenLayoutRef.current = next;
          scheduleLayoutPersist(next);
        }
      });
      const removeDisposable = api.onDidRemovePanel((panel: IDockviewPanel) => {
        syncWindowChromeHostRef.current(apiRef.current ?? api);
        if (isSyncingRef.current) return;
        if (transferredOutRef.current.delete(panel.id)) return;
        if (
          dockScopeRef.current?.startsWith("workspace-bottom-") &&
          isWorkspaceDockOutboundTransfer(panel.id)
        ) {
          transferredOutRef.current.add(panel.id);
          return;
        }
        // 若该 panel 仍出现在外部 tabs 中 => 用户主动关闭
        if (!tabsRef.current.some((t) => t.id === panel.id)) return;
        onCloseTabRef.current(panel.id);
      });
      const activeDisposable = api.onDidActivePanelChange((panel) => {
        const pid = panel?.id ?? "null";
        console.log(`[onDidActivePanelChange] panel=${pid} isProg=${isProgrammaticActiveRef.current} pending=${pendingProgrammaticActiveRef.current} scope=${dockScopeRef.current}`);
        // dockview 的 onDidLayoutChange 通过 queueMicrotask 异步触发，但
        // onDidActivePanelChange 是同步的。onActiveTabChange → setActiveSideTab
        // 会触发 React re-render，其 microtask 可能在 onDidLayoutChange 之前执行。
        // 若不在此同步更新 lastWrittenLayoutRef，savedLayout effect 会看到陈旧的
        // layout 引用并调用 fromJSON，导致所有 panel 被清空重建。
        if (!isSyncingRef.current && layoutLoadedRef.current && panel) {
          try {
            const raw = api.toJSON();
            const normalized = normalizeDockLayout(raw) ?? raw;
            const next = enrichLayoutWithTabMeta(normalized, tabsRef.current);
            lastWrittenLayoutRef.current = next;
            pendingLayoutPersistRef.current = next;
            onSavedLayoutChangeRef.current(next);
            lastWrittenFromActiveRef.current = true;
          } catch {
            // 过渡期间 toJSON 可能抛错，忽略
          }
        }
        if (isProgrammaticActiveRef.current) {
          if (panel && panel.id === pendingProgrammaticActiveRef.current) {
            if (programmaticActiveTimerRef.current) {
              clearTimeout(programmaticActiveTimerRef.current);
              programmaticActiveTimerRef.current = null;
            }
            pendingProgrammaticActiveRef.current = null;
            isProgrammaticActiveRef.current = false;
            console.log(`[onDidActivePanelChange] consumed match, reset`);
          }
          syncStatusBarActiveDockRef.current(panel?.id ?? null);
          return;
        }
        if (panel) {
          console.log(`[onDidActivePanelChange] -> onActiveTabChange(${pid})`);
          onActiveTabChangeRef.current(panel.id);
        }
        syncStatusBarActiveDockRef.current(panel?.id ?? null);
      });
      const scheduleTabGroupSync = () => {
        if (!layoutLoadedRef.current) return;
        queueMicrotask(() => {
          if (!apiRef.current || isSyncingRef.current) return;
          syncTabGroups(apiRef.current);
        });
      };
      const addDisposable = api.onDidAddPanel((panel) => {
        console.log(`[onDidAddPanel] panel=${panel.id} active=${api.activePanel?.id} scope=${dockScopeRef.current}`);
        syncWindowChromeHostRef.current(apiRef.current ?? api);
        scheduleTabGroupSync();
      });
      const moveDisposable = api.onDidMovePanel(() => {
        console.log(`[onDidMovePanel] active=${api.activePanel?.id} scope=${dockScopeRef.current}`);
        syncWindowChromeHostRef.current(apiRef.current ?? api);
        scheduleTabGroupSync();
      });

      const scope = dockScopeRef.current;
      if (scope) {
        viewIdRef.current = api.id;
        registerDockviewInstance(api.id, {
          scope,
          api,
          getContainer: () =>
            wrapperRef.current?.querySelector<HTMLElement>(
              ".dockable-workspace__dockview",
            ) ?? null,
          onPanelTransferredOut: (panelId, targetScope) => {
            transferredOutRef.current.add(panelId);
            onPanelTransferredOutRef.current?.(panelId, targetScope);
          },
        });
      }

      const externalDisposables: Array<{ dispose: () => void }> = [];

      const handleExternalDrop = (
        event: DockviewDidDropEvent | DockviewWillDropEvent,
      ) => {
        if (!isExternalPanelDrop(event, api.id)) return;
        transferPanelToTarget(api.id, event);
      };

      if (acceptExternalDropsRef.current) {
        externalDisposables.push(
          api.onDidDrop((event) => {
            handleExternalDrop(event);
          }),
          api.onUnhandledDragOverEvent((event) => {
            const data = event.getData();
            if (data?.panelId && data.viewId !== api.id) {
              event.accept();
            }
          }),
          api.onWillDrop((event) => {
            if (
              !shouldInterceptExternalDrop(
                event,
                api.id,
                dockScopeRef.current,
                api,
                tabsRef.current.length,
                Boolean(acceptExternalDropsRef.current),
              )
            ) {
              return;
            }
            event.preventDefault();
            handleExternalDrop(event);
          }),
        );
      }

      if (canAcceptExternalDropRef.current || onExternalDropRef.current) {
        externalDisposables.push(
          api.onUnhandledDragOverEvent((event) => {
            const canAccept = canAcceptExternalDropRef.current;
            if (!canAccept) return;
            if (!(event.nativeEvent instanceof DragEvent)) return;
            const dataTransfer = event.nativeEvent.dataTransfer;
            if (!dataTransfer || !canAccept(dataTransfer)) return;
            event.accept();
          }),
          api.onWillDrop((event) => {
            const canAccept = canAcceptExternalDropRef.current;
            const onDrop = onExternalDropRef.current;
            if (!canAccept || !onDrop) return;
            if (!(event.nativeEvent instanceof DragEvent)) return;
            const dataTransfer = event.nativeEvent.dataTransfer;
            if (!dataTransfer || !canAccept(dataTransfer)) return;
            event.preventDefault();
            onDrop(dataTransfer);
          }),
        );
      }

      disposablesRef.current = [
        layoutDisposable,
        removeDisposable,
        activeDisposable,
        addDisposable,
        moveDisposable,
        ...externalDisposables,
      ];

      applyInitialLayout(api);
      syncWindowChromeHostRef.current(api);

      // 同步当前 active tab（用 ref，避免 onReady 因 activeTabId 变化反复注册）
      const initialActiveTabId = activeTabIdRef.current;
      if (initialActiveTabId) {
        const target = api.getPanel(initialActiveTabId);
        if (target) {
          runProgrammaticActive(initialActiveTabId, () => {
            target.api.setActive();
          });
        }
        syncStatusBarActiveDockRef.current(initialActiveTabId);
      }
    },
    [applyInitialLayout, syncTabGroups, scheduleLayoutPersist, runProgrammaticActive],
  );

  useEffect(() => {
    if (!moduleActive) {
      if (dockScopeRef.current) {
        useStatusBarActionBarStore.getState().clearActiveDockIfScope(dockScopeRef.current);
      }
      return;
    }
    const api = apiRef.current;
    const panelId = api?.activePanel?.id ?? activeTabIdRef.current ?? null;
    syncStatusBarActiveDockRef.current(panelId);
  }, [moduleActive]);

  // 卸载时清理
  useEffect(() => {
    return () => {
      for (const d of disposablesRef.current) d.dispose();
      disposablesRef.current = [];
      if (dockScopeRef.current) {
        useStatusBarActionBarStore.getState().clearActiveDockIfScope(dockScopeRef.current);
      }
      if (viewIdRef.current) {
        unregisterDockviewInstance(viewIdRef.current);
        viewIdRef.current = null;
      }
    };
  }, []);

  // 作为跨实例拖放目标或嵌入窗口控制时，即使无 tab 也需保持 dockview 挂载
  const keepDockviewMounted = keepEmptyDockMounted(
    acceptExternalDrops,
    windowControl,
  );

  if (tabs.length === 0 && !keepDockviewMounted) {
    return (
      <div className={`dockable-workspace dock-header-${defaultHeaderPosition}${className ? ` ${className}` : ""}`}>
        <div className="dockable-workspace__empty">{emptyContent}</div>
      </div>
    );
  }

  return (
    <div
      ref={wrapperRef}
      className={`dockable-workspace dock-header-${defaultHeaderPosition}${windowControl ? " dock-window-control" : ""}${className ? ` ${className}` : ""}`}
    >
      <DockErrorBoundary>
        {tabs.length === 0 && emptyContent ? (
          <div className="dockable-workspace__empty dockable-workspace__empty--overlay">
            {emptyContent}
          </div>
        ) : null}
        <DockTabHeaderRuntimeContext.Provider value={tabHeaderRuntime}>
          <DockviewReact
            className="dockable-workspace__dockview"
            components={components}
            defaultRenderer="always"
            {...(defaultTabComponent ? { defaultTabComponent } : {})}
            leftHeaderActionsComponent={
              createPanelRequest || addTabConfig?.show ? leftHeaderActions : undefined
            }
            prefixHeaderActionsComponent={preActions ? prefixHeaderActions : undefined}
            rightHeaderActionsComponent={rightHeaderActions}
            noPanelsOverlay={acceptExternalDrops ? "emptyGroup" : undefined}
            theme={themeDark}
            dndStrategy="pointer"
            defaultHeaderPosition={defaultHeaderPosition}
            disableTabsOverflowList={disableTabsOverflowList}
            {...(scrollbars ? { scrollbars } : {})}
            onReady={handleReady}
          />
        </DockTabHeaderRuntimeContext.Provider>
      </DockErrorBoundary>
    </div>
  );
}

export type { SerializedDockview as DockviewSavedLayout };
