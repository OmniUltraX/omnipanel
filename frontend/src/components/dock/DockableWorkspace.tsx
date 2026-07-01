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
} from "./dockViewLayout";
import { DockErrorBoundary } from "./DockErrorBoundary";
import {
  registerDockviewInstance,
  transferPanelToTarget,
  unregisterDockviewInstance,
} from "../../lib/dockviewRegistry";
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
import type { DockTabIconKind } from "./DockTabIcon";
import type { DockTabPageType } from "./dockableTab";
import type { DockWindowChromeMode } from "./dockWindowChromeActions";
import { DockWindowChromeActions } from "./DockWindowTitleActions";
import { resolveDockWindowChromeLayout, resolveSegmentWindowChromeHosts } from "./dockWindowChromeLayout";
import {
  syncGroupHeaderPosition,
  type DockHeaderPosition,
} from "./dockHeaderPosition";
import type { DockableTab } from "./dockableTab";

export type { DockableTab } from "./dockableTab";

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
  onPanelTransferredOut?: (panelId: string) => void;
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
  icon?: DockTabIconKind;
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

/** 保留可接收外部拖放的空 group，避免 clear 后只剩 watermark 无法落点 */
function ensureExternalDropTarget(api: DockviewApi): void {
  if (api.groups.length === 0) {
    api.addGroup();
  }
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
  const pendingSavedLayoutRef = useRef<SerializedDockview | null>(savedLayout);
  // 跟踪最近一次主动写回 store 的布局；useEffect 用它来识别"自己写回去"vs"外部变更"
  const lastWrittenLayoutRef = useRef<SerializedDockview | null>(null);
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

  // 自定义 tab 关闭按钮 drag-ignore
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const pressedActiveTabIdRef = useRef<string | null>(null);
  useEffect(() => {
    const root = wrapperRef.current;
    if (!root) return;
    const handle = () => {
      root
        .querySelectorAll<HTMLElement>(".dv-default-tab .dv-default-tab-action")
        .forEach((el: HTMLElement) => el.classList.add("drag-ignore"));
    };
    handle();
    const observer = new MutationObserver(handle);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [tabs.length]);

  // windowControl：tab 与窗口按钮之间的 void 区域用于拖拽移动窗口
  useEffect(() => {
    if (!windowControl) return;
    const root = wrapperRef.current;
    if (!root) return;
    const apply = () => {
      root.querySelectorAll<HTMLElement>(".dv-void-container").forEach((el) => {
        el.setAttribute("data-tauri-drag-region", "");
        el.classList.add("dock-window-void-drag");
      });
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [windowControl, tabs.length, layoutReady]);

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
      event.preventDefault();
      event.stopPropagation();
      onTabClickRef.current?.(tabId, true);
    };

    root.addEventListener("pointerdown", onCapturePointerDown, true);
    root.addEventListener("click", onCaptureClick, true);
    return () => {
      root.removeEventListener("pointerdown", onCapturePointerDown, true);
      root.removeEventListener("click", onCaptureClick, true);
    };
  }, [onTabClick, tabs.length]);

  // 加载初始布局（在 onReady 中执行）
  const applyInitialLayout = useCallback((api: DockviewApi) => {
    if (tabsRef.current.length === 0 && acceptExternalDropsRef.current) {
      for (const panel of [...api.panels]) {
        api.removePanel(panel);
      }
      ensureExternalDropTarget(api);
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
        ensureExternalDropTarget(api);
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
      ensureExternalDropTarget(api);
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
            if (acceptExternalDropsRef.current) {
              for (const panel of [...api.panels]) {
                try {
                  api.removePanel(panel);
                } catch {
                  // panel 可能已被 clear 释放
                }
              }
              ensureExternalDropTarget(api);
            } else {
              try {
                api.clear();
              } catch {
                // 忽略重复 clear 导致的 disposed 错误
              }
            }
          }
          persistEmptyLayout();
        } finally {
          isSyncingRef.current = false;
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
          persistLayoutFromApi();
        }
      }
    },
    [syncTabGroups],
  );

  // 同步 tab 变更（添加/删除/重命名）
  useLayoutEffect(() => {
    publishDockTabMeta(tabs);
  }, [tabs]);

  // 同步 tab 栏隐藏（兜底：Tab 头未挂载 hook 时仍按 tabBarHidden 隐藏标签）
  useLayoutEffect(() => {
    const root = wrapperRef.current;
    if (!root) return;
    const hiddenIds = new Set(
      tabs.filter((tab) => tab.tabBarHidden).map((tab) => tab.id),
    );
    root
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
    if (tabs.length === 0 && !acceptExternalDrops) {
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
  }, [tabs.length, acceptExternalDrops]);

  useEffect(() => {
    const api = apiRef.current;
    if (!api || !layoutLoadedRef.current) return;
    syncTabsToApi(api);
  }, [tabIdsKey, syncTabsToApi]);

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

  // 同步重排入口：外层在改变 dock 宽度后、paint 前手动触发，消除异步重排的错位帧。
  useEffect(() => {
    if (!relayoutRef) return;
    const fn = () => {
      const api = apiRef.current;
      if (!api || !layoutLoadedRef.current) return;
      const dockRoot = wrapperRef.current?.querySelector<HTMLElement>(
        ".dockable-workspace__dockview",
      );
      if (!dockRoot) return;
      const w = dockRoot.clientWidth;
      const h = dockRoot.clientHeight;
      if (w <= 0 || h <= 0) return;
      if (defaultHeaderPositionRef.current !== "top") {
        syncGroupHeaderPosition(api, defaultHeaderPositionRef.current);
      }
      api.layout(w, h);
    };
    relayoutRef.current = fn;
    return () => {
      if (relayoutRef.current === fn) relayoutRef.current = null;
    };
  }, [relayoutRef]);

  // 侧栏 header：容器尺寸变化时（如底部半屏工作区展开/收起）重新 layout，
  // 仅作用于 defaultHeaderPosition !== top 的 dock（如 advance-terminal-side-dock）。
  useEffect(() => {
    if (defaultHeaderPosition === "top") return;
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const dockRoot = wrapper.querySelector<HTMLElement>(
      ".dockable-workspace__dockview",
    );
    if (!dockRoot) return;

    const relayout = () => {
      const api = apiRef.current;
      if (!api || !layoutLoadedRef.current) return;
      const w = dockRoot.clientWidth;
      const h = dockRoot.clientHeight;
      if (w <= 0 || h <= 0) return;
      syncGroupHeaderPosition(api, defaultHeaderPositionRef.current);
      api.layout(w, h);
    };

    const observer = new ResizeObserver(() => {
      relayout();
    });
    observer.observe(dockRoot);
    relayout();

    return () => observer.disconnect();
  }, [layoutReady, defaultHeaderPosition]);

  // 同步 activeTabId
  useEffect(() => {
    const api = apiRef.current;
    if (!api || !layoutLoadedRef.current) return;
    if (!activeTabId) return;
    if (!tabs.some((t) => t.id === activeTabId)) return;
    const panel = api.getPanel(activeTabId);
    if (panel && api.activePanel?.id !== activeTabId) {
      isProgrammaticActiveRef.current = true;
      try {
        panel.api.setActive();
      } finally {
        isProgrammaticActiveRef.current = false;
      }
    }
  }, [activeTabId, tabs]);

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
        syncWindowChromeHostRef.current(apiRef.current ?? api);
        if (isSyncingRef.current || !layoutLoadedRef.current) return;
        const raw = api.toJSON();
        const normalized = normalizeDockLayout(raw) ?? raw;
        const next = enrichLayoutWithTabMeta(normalized, tabsRef.current);
        lastWrittenLayoutRef.current = next;
        onSavedLayoutChangeRef.current(next);
      });
      const removeDisposable = api.onDidRemovePanel((panel: IDockviewPanel) => {
        syncWindowChromeHostRef.current(apiRef.current ?? api);
        if (isSyncingRef.current) return;
        if (transferredOutRef.current.delete(panel.id)) return;
        // 若该 panel 仍出现在外部 tabs 中 => 用户主动关闭
        if (!tabsRef.current.some((t) => t.id === panel.id)) return;
        onCloseTabRef.current(panel.id);
      });
      const activeDisposable = api.onDidActivePanelChange((panel) => {
        if (isProgrammaticActiveRef.current) return;
        if (panel) {
          onActiveTabChangeRef.current(panel.id);
        }
      });
      const scheduleTabGroupSync = () => {
        if (!layoutLoadedRef.current) return;
        queueMicrotask(() => {
          if (!apiRef.current || isSyncingRef.current) return;
          syncTabGroups(apiRef.current);
        });
      };
      const addDisposable = api.onDidAddPanel(() => {
        syncWindowChromeHostRef.current(apiRef.current ?? api);
        scheduleTabGroupSync();
      });
      const moveDisposable = api.onDidMovePanel(() => {
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
          onPanelTransferredOut: (panelId) => {
            transferredOutRef.current.add(panelId);
            onPanelTransferredOutRef.current?.(panelId);
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
            if (!isExternalPanelDrop(event, api.id)) return;
            const emptyDropTarget =
              acceptExternalDropsRef.current &&
              tabsRef.current.length === 0 &&
              api.panels.length === 0;
            // 根级 edge 落点，或空工作区内容区：阻止 moveGroupOrPanel，改走 transfer
            if (event.kind === "edge" || emptyDropTarget) {
              event.preventDefault();
              handleExternalDrop(event);
            }
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
          isProgrammaticActiveRef.current = true;
          try {
            target.api.setActive();
          } finally {
            isProgrammaticActiveRef.current = false;
          }
        }
      }
    },
    [applyInitialLayout, syncTabGroups],
  );

  // 卸载时清理
  useEffect(() => {
    return () => {
      for (const d of disposablesRef.current) d.dispose();
      disposablesRef.current = [];
      if (viewIdRef.current) {
        unregisterDockviewInstance(viewIdRef.current);
        viewIdRef.current = null;
      }
    };
  }, []);

  // 作为跨实例拖放目标时，即使无 tab 也需保持 dockview 挂载以接收 drop
  const keepDockviewMounted = acceptExternalDrops;

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
            {...(defaultTabComponent ? { defaultTabComponent } : {})}
            leftHeaderActionsComponent={
              createPanelRequest || addTabConfig?.show ? leftHeaderActions : undefined
            }
            prefixHeaderActionsComponent={preActions ? prefixHeaderActions : undefined}
            rightHeaderActionsComponent={
              windowControl ? rightHeaderActions : undefined
            }
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
