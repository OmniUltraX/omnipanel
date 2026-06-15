import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
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
  isLayoutUsable,
} from "./dockViewLayout";
import { DockErrorBoundary } from "./DockErrorBoundary";
import {
  registerDockviewInstance,
  transferPanelToTarget,
  unregisterDockviewInstance,
} from "../../lib/dockviewRegistry";
import { syncTabGroupsByPanelType, clearTabGroups } from "./dockTabGroups";
import { DockTabHeader } from "./DockTabHeader";
import { syncPanelTabParams, tabParamsFromDockableTab } from "./dockTabParams";
import type { DockTabIconKind } from "./DockTabIcon";
import {
  syncGroupHeaderPosition,
  type DockHeaderPosition,
} from "./dockHeaderPosition";

export interface DockableTab {
  id: string;
  label: string;
  /** 面板类型：同模块面板共享类型，用于 tab group 折叠 */
  panelType: string;
  closable?: boolean;
  /** Tab 图标（窄侧栏仅显示图标，完整标题走 tooltip） */
  icon?: DockTabIconKind;
  /** 悬停提示；默认使用 label */
  tooltip?: string;
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
}

interface PanelParams {
  tabId: string;
  label?: string;
  icon?: DockTabIconKind;
  tooltip?: string;
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
}: DockableWorkspaceProps) {
  const apiRef = useRef<DockviewApi | null>(null);
  const viewIdRef = useRef<string | null>(null);
  const transferredOutRef = useRef(new Set<string>());
  const layoutLoadedRef = useRef(false);
  const isSyncingRef = useRef(false);
  const pendingSavedLayoutRef = useRef<SerializedDockview | null>(savedLayout);
  // 跟踪最近一次主动写回 store 的布局；useEffect 用它来识别"自己写回去"vs"外部变更"
  const lastWrittenLayoutRef = useRef<SerializedDockview | null>(null);

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
  const acceptExternalDropsRef = useRef(acceptExternalDrops);
  acceptExternalDropsRef.current = acceptExternalDrops;
  const canAcceptExternalDropRef = useRef(canAcceptExternalDrop);
  canAcceptExternalDropRef.current = canAcceptExternalDrop;
  const onExternalDropRef = useRef(onExternalDrop);
  onExternalDropRef.current = onExternalDrop;
  const onTabContextMenuRef = useRef(onTabContextMenu);
  onTabContextMenuRef.current = onTabContextMenu;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const resolveTabGroupMetaRef = useRef(resolveTabGroupMeta);
  resolveTabGroupMetaRef.current = resolveTabGroupMeta;
  const defaultHeaderPositionRef = useRef(defaultHeaderPosition);
  defaultHeaderPositionRef.current = defaultHeaderPosition;
  const enableTabGroupsRef = useRef(enableTabGroups);
  enableTabGroupsRef.current = enableTabGroups;

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

  // 单组件：所有 panel 共享一个 React 组件，渲染内容靠 params.tabId
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

  // 头部左侧：通过 dockview API 新建面板
  const leftHeaderActions = useCallback(
    (props: IDockviewHeaderActionsProps) => {
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
    if (existing.size === tabsRef.current.length) {
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
  }, [syncTabGroups]);

  // 同步 tab 变更（添加/删除/重命名）
  useEffect(() => {
    const api = apiRef.current;
    if (!api || !layoutLoadedRef.current) return;
    if (tabs.length === 0) {
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
      // 移除不再存在的 panel
      const desiredIds = new Set(tabs.map((t) => t.id));
      const scopePrefix = dockScopeRef.current ? `${dockScopeRef.current}:` : null;
      for (const panel of [...api.panels]) {
        if (!desiredIds.has(panel.id)) {
          // 跨实例拖入后 store 尚未追上 api 时，避免误删带 scope 前缀的镜像 panel
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
      // 新增 / 改名
      const existing = new Set(api.panels.map((p) => p.id));
      for (const tab of tabs) {
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
    }
  }, [tabs, syncTabGroups]);

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

    if (savedLayout) {
      const normalized = normalizeDockLayout(savedLayout) ?? savedLayout;
      if (!isLayoutUsable(normalized)) {
        pendingSavedLayoutRef.current = null;
        onSavedLayoutChangeRef.current(null);
        try {
          apiRef.current.clear();
        } catch {
          // 忽略
        }
      } else {
        try {
          isSyncingRef.current = true;
          apiRef.current.fromJSON(normalized);
        } catch (err) {
          console.warn("[DockableWorkspace] fromJSON (savedLayout) failed, resetting", err);
          pendingSavedLayoutRef.current = null;
          onSavedLayoutChangeRef.current(null);
          try {
            apiRef.current.clear();
          } catch {
            // 忽略
          }
        } finally {
          isSyncingRef.current = false;
        }
      }
    } else {
      apiRef.current.clear();
    }
    lastWrittenLayoutRef.current = savedLayout;
    if (apiRef.current) {
      syncTabGroups(apiRef.current);
    }
  }, [savedLayout, syncTabGroups]);

  const disposablesRef = useRef<Array<{ dispose: () => void }>>([]);

  // 注册 dockview 事件
  const handleReady = useCallback(
    (event: DockviewReadyEvent) => {
      const api = event.api;
      apiRef.current = api;

      const layoutDisposable = api.onDidLayoutChange(() => {
        if (isSyncingRef.current || !layoutLoadedRef.current) return;
        const raw = api.toJSON();
        const next = normalizeDockLayout(raw) ?? raw;
        lastWrittenLayoutRef.current = next;
        onSavedLayoutChangeRef.current(next);
      });
      const removeDisposable = api.onDidRemovePanel((panel: IDockviewPanel) => {
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
      const addDisposable = api.onDidAddPanel(() => scheduleTabGroupSync());
      const moveDisposable = api.onDidMovePanel(() => scheduleTabGroupSync());

      const scope = dockScopeRef.current;
      if (scope) {
        viewIdRef.current = api.id;
        registerDockviewInstance(api.id, {
          scope,
          api,
          onPanelTransferredOut: (panelId) => {
            transferredOutRef.current.add(panelId);
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
      className={`dockable-workspace dock-header-${defaultHeaderPosition}${className ? ` ${className}` : ""}`}
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
            createPanelRequest ? leftHeaderActions : undefined
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
