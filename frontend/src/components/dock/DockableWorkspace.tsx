import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewHeaderActionsProps,
  type IDockviewPanel,
  type IDockviewPanelHeaderProps,
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
} from "./dockViewLayout";
import { DockErrorBoundary } from "./DockErrorBoundary";
import {
  registerDockviewInstance,
  transferPanelToTarget,
  unregisterDockviewInstance,
} from "../../lib/dockviewRegistry";
import { syncTabGroupsByPanelType, clearTabGroups } from "./dockTabGroups";
import { DockTabHeader } from "./DockTabHeader";
import { TopbarStyleDockTabHeader } from "./TopbarStyleDockTabHeader";
import { TopbarTabAddButton } from "../ui/TopbarTabAddButton";
import type { TopbarAddMenuItem } from "../../stores/topbarStore";
import type { TopbarTabDef } from "../../stores/topbarStore";
import { syncPanelTabParams, tabParamsFromDockableTab } from "./dockTabParams";
import type { DockTabIconKind } from "./DockTabIcon";
import { DockWindowChromeActions, type DockWindowChromeMode } from "./DockWindowTitleActions";
import { resolveDockWindowChromeLayout, resolveSegmentWindowChromeHosts } from "./dockWindowChromeLayout";
import {
  syncGroupHeaderPosition,
  type DockHeaderPosition,
} from "./dockHeaderPosition";
import type { DockableTab } from "./dockableTab";
import { logDockLayoutChange } from "./dockLayoutLog";

export type { DockableTab } from "./dockableTab";

export interface DockAddTabConfig {
  show?: boolean;
  title?: string;
  onAdd?: () => void;
  menuItems?: TopbarAddMenuItem[];
  onMenuSelect?: (id: string) => void;
}

export interface DockableWorkspaceProps {
  tabs: DockableTab[];
  activeTabId: string;
  onActiveTabChange: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  savedLayout: SerializedDockview | null;
  onSavedLayoutChange: (layout: SerializedDockview | null) => void;
  renderPanel: (tabId: string) => ReactNode;
  className?: string;
  emptyContent?: ReactNode;
  onTabContextMenu?: (
    event: React.MouseEvent,
    tabId: string,
    index: number,
  ) => void;
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
  /** 为 false 时不按 panelType 折叠为 tab group（数据库等同类型多 Tab 需直接展示） */
  enableTabGroups?: boolean;
  /** topbar 风格 tab 栏（终端 session tab） */
  tabStyle?: "default" | "topbar";
  /** 右侧「+」新建 tab / 菜单（与顶栏 TopbarTabs 行为一致） */
  addTabConfig?: DockAddTabConfig;
  /** Tab 栏前缀区域（dockview dv-pre-actions-container / prefixHeaderActions） */
  preActions?: ReactNode;
  /** 布局变化时在 tab 栏右侧嵌入窗口拖拽区与控制按钮 */
  windowControl?: boolean;
  /** 当前 dock 内 panel 被跨 dockview 拖出后，通知业务 store 做迁出清理 */
  onPanelTransferredOut?: (panelId: string) => void;
  /**
   * segment：模块分段 Tab（ModuleSegmentDock），单 group tab 栏固定含 drag-spacer。
   * default：按布局树解析顶部/右上角 group。
   */
  windowChromeVariant?: "default" | "segment";
}

interface PanelParams {
  tabId: string;
  label?: string;
  icon?: DockTabIconKind;
  tooltip?: string;
  status?: TopbarTabDef["status"];
  /** 递增以触发 panel 内容重渲染（renderPanel 通过 ref 注入，需靠 params 变更通知 dockview） */
  contentRev?: number;
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
  className,
  emptyContent,
  onTabContextMenu,
  createPanelRequest,
  dockScope,
  acceptExternalDrops = false,
  canAcceptExternalDrop,
  onExternalDrop,
  resolveTabGroupMeta,
  defaultHeaderPosition = "top",
  enableTabGroups = true,
  tabStyle = "default",
  addTabConfig,
  preActions,
  windowControl = false,
  onPanelTransferredOut,
  windowChromeVariant = "default",
}: DockableWorkspaceProps) {
  const [windowChromeHosts, setWindowChromeHosts] = useState<{
    dragGroupId: string | null;
    controlsGroupId: string | null;
  }>({ dragGroupId: null, controlsGroupId: null });
  const apiRef = useRef<DockviewApi | null>(null);
  const viewIdRef = useRef<string | null>(null);
  const transferredOutRef = useRef(new Set<string>());
  const layoutLoadedRef = useRef(false);
  const isSyncingRef = useRef(false);
  const pendingSavedLayoutRef = useRef<SerializedDockview | null>(savedLayout);
  // 跟踪最近一次主动写回 store 的布局；useEffect 用它来识别"自己写回去"vs"外部变更"
  const lastWrittenLayoutRef = useRef<SerializedDockview | null>(null);
  /** 上一轮 effect 见到的 savedLayout prop；区分「始终 null」与「外部主动清空持久化布局」 */
  const prevSavedLayoutPropRef = useRef<SerializedDockview | null | undefined>(undefined);

  // 回调 ref —— 避免 children 重渲染
  const renderPanelRef = useRef(renderPanel);
  renderPanelRef.current = renderPanel;
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
  const classNameRef = useRef(className);
  classNameRef.current = className;
  const acceptExternalDropsRef = useRef(acceptExternalDrops);
  acceptExternalDropsRef.current = acceptExternalDrops;
  const canAcceptExternalDropRef = useRef(canAcceptExternalDrop);
  canAcceptExternalDropRef.current = canAcceptExternalDrop;
  const onExternalDropRef = useRef(onExternalDrop);
  onExternalDropRef.current = onExternalDrop;
  const onTabContextMenuRef = useRef(onTabContextMenu);
  onTabContextMenuRef.current = onTabContextMenu;
  const onPanelTransferredOutRef = useRef(onPanelTransferredOut);
  onPanelTransferredOutRef.current = onPanelTransferredOut;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
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

  const logLayoutRef = useRef(
    (layout: SerializedDockview, source: "layout-change" | "initial-load" | "saved-layout") => {
      logDockLayoutChange(
        layout,
        {
          source,
          dockScope: dockScopeRef.current,
          className: classNameRef.current,
        },
        apiRef.current,
      );
    },
  );
  const tabStyleRef = useRef(tabStyle);
  tabStyleRef.current = tabStyle;
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
    } finally {
      isSyncingRef.current = false;
    }
  }, []);

  // 单组件：所有 panel 共享一个 React 组件，渲染内容靠 params.tabId + contentRev
  const components = useMemo(
    () => ({
      [COMPONENT_NAME]: (props: IDockviewPanelProps<PanelParams>) => (
        <div className="dock-pane-surface">
          {renderPanelRef.current(props.params.tabId)}
        </div>
      ),
    }),
    [],
  );

  // renderPanel 变更时 bump contentRev，否则 dockview 不会重绘 panel 内容
  useEffect(() => {
    const api = apiRef.current;
    if (!api || !layoutLoadedRef.current) return;
    bumpPanelContentRev(api);
  }, [renderPanel, bumpPanelContentRev]);

  // 自定义 tab：元数据通过 panel params 同步，确保图标/标题更新能触发重渲染
  const defaultTabComponent = useCallback(
    (props: IDockviewPanelHeaderProps<PanelParams>) => {
      const tabId = props.params?.tabId ?? props.api.id;
      const tabsList = tabsRef.current;
      const tab = tabsList.find((t) => t.id === tabId);
      const closable = tab?.closable !== false;
      const onCtx = onTabContextMenuRef.current;
      const handleContextMenu = onCtx
        ? (e: ReactMouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            const index = tabsList.findIndex((t) => t.id === tabId);
            onCtx(e, tabId, index >= 0 ? index : 0);
          }
        : undefined;
      if (tabStyleRef.current === "topbar") {
        return (
          <TopbarStyleDockTabHeader
            {...props}
            closable={closable}
            onContextMenu={handleContextMenu}
          />
        );
      }
      return (
        <DockTabHeader
          {...props}
          closable={closable}
          onContextMenu={handleContextMenu}
        />
      );
    },
    [],
  );

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
      return <DockWindowChromeActions mode={mode} />;
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

  // 加载初始布局（在 onReady 中执行）
  const applyInitialLayout = useCallback((api: DockviewApi) => {
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
      layoutLoadedRef.current = true;
      syncTabGroups(api);
      if (acceptExternalDropsRef.current) {
        ensureExternalDropTarget(api);
      }
      bumpPanelContentRev(api);
      syncWindowChromeHostRef.current(api);
      const initialLayout = normalizeDockLayout(api.toJSON()) ?? api.toJSON();
      logLayoutRef.current(initialLayout, "initial-load");
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
            inactive: true,
          };
          if (firstPanel) {
            options.position = {
              referencePanel: firstPanel.id,
              direction: "within",
            };
          }
          api.addPanel(options);
          existing.add(tab.id);
        } catch (err) {
          // 防御性兜底：dockview 抛 "panel already exists" 时跳过
          console.warn("[DockableWorkspace] addPanel failed for", tab.id, err);
        }
      }
    } finally {
      isSyncingRef.current = false;
    }
    layoutLoadedRef.current = true;
    syncTabGroups(api);
    if (acceptExternalDropsRef.current) {
      ensureExternalDropTarget(api);
    }
    bumpPanelContentRev(api);
    syncWindowChromeHostRef.current(api);
    const initialLayout = normalizeDockLayout(api.toJSON()) ?? api.toJSON();
    logLayoutRef.current(initialLayout, "initial-load");
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
            inactive: true,
          };
          if (firstPanel) {
            options.position = {
              referencePanel: firstPanel.id,
              direction: "within",
            };
          }
          api.addPanel(options);
          existingAfterLoad.add(tab.id);
        } catch (err) {
          console.warn("[DockableWorkspace] ensure panel after initial layout failed for", tab.id, err);
        }
      }
      syncTabGroups(api);
    }
  }, [syncTabGroups, bumpPanelContentRev]);

  /** 将 tabs 元数据同步到 dockview api（布局被 clear 后亦需调用以恢复 panel） */
  const syncTabsToApi = useCallback(
    (api: DockviewApi) => {
      const currentTabs = tabsRef.current;
      if (currentTabs.length === 0) {
        if (acceptExternalDropsRef.current) {
          for (const panel of [...api.panels]) {
            api.removePanel(panel);
          }
          ensureExternalDropTarget(api);
        } else {
          api.clear();
        }
        return;
      }
      isSyncingRef.current = true;
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
            api.removePanel(panel);
          }
        }
        const existing = new Set(api.panels.map((p) => p.id));
        for (const tab of currentTabs) {
          if (!existing.has(tab.id)) {
            const firstPanel = api.panels[0];
            const options: Parameters<typeof api.addPanel>[0] = {
              id: tab.id,
              component: COMPONENT_NAME,
              params: tabParamsFromDockableTab(tab),
              title: tab.label,
              inactive: true,
            };
            if (firstPanel) {
              options.position = {
                referencePanel: firstPanel.id,
                direction: "within",
              };
            }
            api.addPanel(options);
          } else {
            syncPanelTabParams(api, tab);
          }
        }
        syncTabGroups(api, false);
      } finally {
        isSyncingRef.current = false;
        syncWindowChromeHostRef.current(api);
      }
    },
    [syncTabGroups],
  );

  // 同步 tab 变更（添加/删除/重命名）
  useEffect(() => {
    const api = apiRef.current;
    if (!api || !layoutLoadedRef.current) return;
    syncTabsToApi(api);
  }, [tabs, syncTabsToApi]);

  // 同步 activeTabId
  useEffect(() => {
    const api = apiRef.current;
    if (!api || !layoutLoadedRef.current) return;
    if (!activeTabId) return;
    if (!tabs.some((t) => t.id === activeTabId)) return;
    const panel = api.getPanel(activeTabId);
    if (panel && api.activePanel?.id !== activeTabId) {
      isSyncingRef.current = true;
      try {
        panel.api.setActive();
      } finally {
        isSyncingRef.current = false;
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
          const loaded = normalizeDockLayout(apiRef.current.toJSON()) ?? apiRef.current.toJSON();
          logLayoutRef.current(loaded, "saved-layout");
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
      if (prevProp !== undefined && prevProp !== null) {
        try {
          apiRef.current.clear();
          needsPanelResync = true;
        } catch {
          // 忽略
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
        logLayoutRef.current(next, "layout-change");
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
        if (isSyncingRef.current) return;
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
            // 根级 edge 落点：阻止 moveGroupOrPanel（跨实例会失败），改走 transfer
            if (event.kind === "edge") {
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

      // 同步当前 active tab
      if (activeTabId) {
        const target = api.getPanel(activeTabId);
        if (target) {
          isSyncingRef.current = true;
          try {
            target.api.setActive();
          } finally {
            isSyncingRef.current = false;
          }
        }
      }
    },
    [activeTabId, applyInitialLayout, syncTabGroups],
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
        <DockviewReact
          className="dockable-workspace__dockview"
          components={components}
          defaultTabComponent={defaultTabComponent}
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
          onReady={handleReady}
        />
      </DockErrorBoundary>
    </div>
  );
}

export type { SerializedDockview as DockviewSavedLayout };
