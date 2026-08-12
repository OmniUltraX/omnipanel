import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Layout } from "react-grid-layout";
import type { DockerContainerSummary } from "../../ipc/bindings";
import { CUSTOM_PANEL_GRID_COLS } from "./customPanelGrid";
import { resolveWidgetSizeId } from "./smallComponents/formatWidgetSizeLabel";
import { getSmallComponent } from "./smallComponents/registry";
import {
  migrateServerMonitorSizeId,
  SERVER_RESOURCE_MONITOR_TYPE,
} from "./smallComponents/serverResourceMonitor/layout";
import {
  MYSQL_OVERVIEW_SIZES,
  MYSQL_OVERVIEW_TYPE,
} from "./smallComponents/mysqlOverview/layout";
import {
  REDIS_OVERVIEW_SIZES,
  REDIS_OVERVIEW_TYPE,
} from "./smallComponents/redisOverview/layout";
import {
  applyWidgetScale,
  DEFAULT_WIDGET_SCALE,
  inferWidgetScale,
  normalizeWidgetScale,
  resolveBaseSizePreset,
  sizeBoundsWithScale,
  type WidgetScale,
} from "./smallComponents/widgetScale";
import {
  getDefaultSize,
  type HomeCustomPanelWidget,
  type HomeCustomPanelWidgetTarget,
} from "./smallComponents/types";

/** 首页内置单例页面 */
export type HomeBuiltinPageId = "board";

/** 自定义面板 id：`custom:<uuid>` */
export type HomeCustomPanelId = `custom:${string}`;

export type HomeDashboardTabId = HomeBuiltinPageId | HomeCustomPanelId;

/** 自定义面板元数据（含小组件布局） */
export interface HomeCustomPanelMeta {
  id: HomeCustomPanelId;
  label: string;
  createdAt: number;
  widgets: HomeCustomPanelWidget[];
}

/** 首页可打开的内置页面（顺序即新建菜单顺序） */
export const HOME_DASHBOARD_PAGE_IDS: readonly HomeBuiltinPageId[] = [
  "board",
] as const;

const CUSTOM_PANEL_ID_RE = /^custom:.+/;
const DEFAULT_OPEN_TABS: HomeDashboardTabId[] = ["board"];
const CREATE_CUSTOM_MENU_ID = "create-custom-panel";
const GRID_COLS = CUSTOM_PANEL_GRID_COLS;

export function isHomeBuiltinPageId(id: string): id is HomeBuiltinPageId {
  return (HOME_DASHBOARD_PAGE_IDS as readonly string[]).includes(id);
}

export function isHomeCustomPanelId(id: string): id is HomeCustomPanelId {
  return CUSTOM_PANEL_ID_RE.test(id);
}

export function isHomeDashboardTabId(id: string): id is HomeDashboardTabId {
  return isHomeBuiltinPageId(id) || isHomeCustomPanelId(id);
}

function makeId(prefix: string): string {
  const uuid =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}${uuid}`;
}

function makeCustomPanelId(): HomeCustomPanelId {
  return `custom:${makeId("")}` as HomeCustomPanelId;
}

function makeWidgetInstanceId(): string {
  return makeId("w-");
}

function sanitizeWidgetTarget(raw: unknown): HomeCustomPanelWidgetTarget | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const rec = raw as Record<string, unknown>;
  if (rec.kind === "docker-container" && typeof rec.containerId === "string") {
    const containerId = rec.containerId.trim();
    if (containerId) return { kind: "docker-container", containerId };
  }
  if (rec.kind === "docker-compose" && typeof rec.composeProject === "string") {
    const composeProject = rec.composeProject.trim();
    if (composeProject) return { kind: "docker-compose", composeProject };
  }
  if (rec.kind === "database-schema" && typeof rec.database === "string") {
    const database = rec.database.trim();
    if (database) return { kind: "database-schema", database };
  }
  return undefined;
}

/** 用定义预设并集（含 2×）覆盖实例缩放边界 */
function withDefinitionResizeBounds(
  type: string,
  layout: HomeCustomPanelWidget["layout"],
): HomeCustomPanelWidget["layout"] {
  const def = getSmallComponent(type);
  if (!def?.sizes?.length) return layout;
  const bounds = sizeBoundsWithScale(def.sizes);
  return {
    ...layout,
    minW: bounds.minW,
    minH: bounds.minH,
    maxW: bounds.maxW,
    maxH: bounds.maxH,
  };
}

/**
 * 按 sizeId 预设 × scale 得到有效栅格。
 * MySQL 等固定预设在布局回调时也靠此纠正，避免旧 persist / RGL 写回错误值。
 */
function layoutFromSizeScale(
  type: string,
  sizeId: string | undefined,
  scale: WidgetScale,
  layout: HomeCustomPanelWidget["layout"],
): HomeCustomPanelWidget["layout"] {
  const def = getSmallComponent(type);
  const sizes =
    type === MYSQL_OVERVIEW_TYPE
      ? MYSQL_OVERVIEW_SIZES
      : type === REDIS_OVERVIEW_TYPE
        ? REDIS_OVERVIEW_SIZES
        : (def?.sizes ?? []);
  const base = resolveBaseSizePreset(sizes, sizeId);
  if (!base) return withDefinitionResizeBounds(type, layout);
  const scaled = applyWidgetScale(base, scale);
  return withDefinitionResizeBounds(type, {
    ...layout,
    w: scaled.w,
    h: scaled.h,
  });
}

function sanitizeWidgets(raw: unknown): HomeCustomPanelWidget[] {
  if (!Array.isArray(raw)) return [];
  const next: HomeCustomPanelWidget[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Partial<HomeCustomPanelWidget> & {
      layout?: Partial<HomeCustomPanelWidget["layout"]>;
    };
    if (typeof rec.id !== "string" || !rec.id || seen.has(rec.id)) continue;
    if (typeof rec.type !== "string" || !rec.type) continue;
    const layout = rec.layout;
    if (!layout || typeof layout !== "object") continue;
    const x = Number(layout.x);
    const y = Number(layout.y);
    let w = Number(layout.w);
    let h = Number(layout.h);
    if (![x, y, w, h].every((n) => Number.isFinite(n))) continue;
    seen.add(rec.id);
    let sizeId =
      typeof rec.sizeId === "string" && rec.sizeId ? rec.sizeId : undefined;

    // 服务器监控：旧 1x4 / 2x2 迁移到新内容模式 id
    if (rec.type === SERVER_RESOURCE_MONITOR_TYPE) {
      const mode = migrateServerMonitorSizeId(sizeId, { w, h });
      if (mode) {
        sizeId = mode;
      }
    }

    // MySQL 概览：统一固定为 4×3 基座
    if (rec.type === MYSQL_OVERVIEW_TYPE) {
      const preset = MYSQL_OVERVIEW_SIZES[0];
      if (preset) {
        sizeId = preset.id ?? "4x3";
      }
    }

    // Redis 概览：统一固定为 4×3 基座
    if (rec.type === REDIS_OVERVIEW_TYPE) {
      const preset = REDIS_OVERVIEW_SIZES[0];
      if (preset) {
        sizeId = preset.id ?? "4x3";
      }
    }

    const def = getSmallComponent(rec.type);
    const sizes =
      rec.type === MYSQL_OVERVIEW_TYPE
        ? MYSQL_OVERVIEW_SIZES
        : rec.type === REDIS_OVERVIEW_TYPE
          ? REDIS_OVERVIEW_SIZES
          : (def?.sizes ?? []);
    const base = resolveBaseSizePreset(sizes, sizeId);
    const scale = inferWidgetScale(base, { w, h }, rec.scale);
    const scaled = base
      ? applyWidgetScale(base, scale)
      : { w: Math.max(1, Math.floor(w)), h: Math.max(1, Math.floor(h)) };
    if (base) {
      sizeId = base.id ?? `${base.h}x${base.w}`;
    }

    next.push({
      id: rec.id,
      type: rec.type,
      sizeId,
      scale,
      dataSourceId:
        typeof rec.dataSourceId === "string" && rec.dataSourceId
          ? rec.dataSourceId
          : undefined,
      target: sanitizeWidgetTarget(rec.target),
      layout: withDefinitionResizeBounds(rec.type, {
        x: Math.max(0, Math.floor(x)),
        y: Math.max(0, Math.floor(y)),
        w: scaled.w,
        h: scaled.h,
      }),
    });
  }
  return next;
}

function sanitizeOpenTabs(
  ids: unknown,
  customPanels: Record<string, HomeCustomPanelMeta>,
): HomeDashboardTabId[] {
  if (!Array.isArray(ids)) return [...DEFAULT_OPEN_TABS];
  const seen = new Set<string>();
  const next: HomeDashboardTabId[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || seen.has(id)) continue;
    if (isHomeBuiltinPageId(id)) {
      seen.add(id);
      next.push(id);
      continue;
    }
    if (isHomeCustomPanelId(id) && customPanels[id]) {
      seen.add(id);
      next.push(id);
    }
  }
  return next;
}

function sanitizeCustomPanels(raw: unknown): Record<string, HomeCustomPanelMeta> {
  if (!raw || typeof raw !== "object") return {};
  const next: Record<string, HomeCustomPanelMeta> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isHomeCustomPanelId(key) || !value || typeof value !== "object") continue;
    const meta = value as Partial<HomeCustomPanelMeta>;
    const label = typeof meta.label === "string" ? meta.label.trim() : "";
    if (!label) continue;
    next[key] = {
      id: key,
      label,
      createdAt: typeof meta.createdAt === "number" ? meta.createdAt : Date.now(),
      widgets: sanitizeWidgets(meta.widgets),
    };
  }
  return next;
}

function pickActiveAfterClose(
  prevOpen: HomeDashboardTabId[],
  closedId: HomeDashboardTabId,
  prevActive: HomeDashboardTabId,
): HomeDashboardTabId | null {
  const closedIndex = prevOpen.indexOf(closedId);
  const openTabIds = prevOpen.filter((id) => id !== closedId);
  if (openTabIds.length === 0) return null;
  if (prevActive !== closedId && openTabIds.includes(prevActive)) {
    return prevActive;
  }
  return openTabIds[closedIndex] ?? openTabIds[closedIndex - 1] ?? openTabIds[0];
}

function nextWidgetOrigin(
  widgets: HomeCustomPanelWidget[],
  w: number,
): { x: number; y: number } {
  if (widgets.length === 0) return { x: 0, y: 0 };
  let maxY = 0;
  for (const widget of widgets) {
    maxY = Math.max(maxY, widget.layout.y + widget.layout.h);
  }
  const x = w >= GRID_COLS ? 0 : 0;
  return { x, y: maxY };
}

function layoutsEqual(
  a: HomeCustomPanelWidget["layout"],
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

export interface DashboardContainerState {
  /** 最近一次成功拉取的容器列表（去重后） */
  containers: DockerContainerSummary[];
  /** 是否正在拉取 */
  loading: boolean;
  /** 拉取失败的次数（仅用于提示，不影响重试） */
  failureCount: number;
  /** 最近一次拉取完成的 epoch ms（用于判断 stale-while-revalidate） */
  lastUpdatedAt: number;
}

interface DashboardState extends DashboardContainerState {
  /** 首页当前激活 tab */
  homeTabId: HomeDashboardTabId;
  /** 首页已打开的 tab（可关闭；空则显示空态） */
  openTabIds: HomeDashboardTabId[];
  /** 自定义面板元数据（按 id 索引） */
  customPanels: Record<string, HomeCustomPanelMeta>;
  setHomeTabId: (tabId: HomeDashboardTabId) => void;
  /** 打开（或聚焦）一个内置首页页面 */
  openHomeTab: (tabId: HomeBuiltinPageId) => void;
  /** 新建自定义面板并激活 */
  createCustomPanel: (label: string) => HomeCustomPanelId;
  /** 重命名自定义面板 */
  renameCustomPanel: (tabId: HomeCustomPanelId, label: string) => void;
  /** 同步 react-grid-layout 拖拽移动后的布局 */
  setCustomPanelLayout: (panelId: HomeCustomPanelId, layout: Layout) => void;
  /** 向自定义面板添加已注册的小组件 */
  addCustomPanelWidget: (panelId: HomeCustomPanelId, type: string) => string | null;
  /** 按预制尺寸切换小组件栅格 w/h（保留当前 scale） */
  setCustomPanelWidgetSize: (
    panelId: HomeCustomPanelId,
    widgetId: string,
    sizeId: string,
  ) => void;
  /** 等比缩放 1× / 2×（相对当前 sizeId 预设） */
  setCustomPanelWidgetScale: (
    panelId: HomeCustomPanelId,
    widgetId: string,
    scale: WidgetScale,
  ) => void;
  /** 设置小组件数据源（连接 id） */
  setCustomPanelWidgetDataSource: (
    panelId: HomeCustomPanelId,
    widgetId: string,
    dataSourceId: string | null,
  ) => void;
  /** 设置小组件二级目标（Docker 容器 / Compose 等） */
  setCustomPanelWidgetTarget: (
    panelId: HomeCustomPanelId,
    widgetId: string,
    target: HomeCustomPanelWidgetTarget | null,
  ) => void;
  /** 移除自定义面板中的小组件实例 */
  removeCustomPanelWidget: (panelId: HomeCustomPanelId, widgetId: string) => void;
  /** 关闭首页 tab；若关掉当前激活页则切到邻接页 */
  closeHomeTab: (tabId: HomeDashboardTabId) => void;
  /** 触发刷新的递增信号；HomeBoardView 订阅后重新拉数据 */
  refreshSignal: number;
  /** 调用即自增 refreshSignal，HomeBoardView 拉数据 */
  triggerRefresh: () => void;
  /** 直接写入容器拉取结果（useDashboardData 内部调用） */
  setContainerSnapshot: (snapshot: {
    containers: DockerContainerSummary[];
    loading: boolean;
    failureCount: number;
  }) => void;
  /** 重置失败计数（拉取成功时） */
  clearFailure: () => void;
}

const EMPTY: DashboardContainerState = {
  containers: [],
  loading: true,
  failureCount: 0,
  lastUpdatedAt: 0,
};

export const useDashboardStore = create<DashboardState>()(
  persist(
    (set) => ({
      ...EMPTY,
      homeTabId: "board",
      openTabIds: [...DEFAULT_OPEN_TABS],
      customPanels: {},
      setHomeTabId: (homeTabId) =>
        set((state) => {
          if (!state.openTabIds.includes(homeTabId)) return state;
          return { homeTabId };
        }),
      openHomeTab: (tabId) =>
        set((state) => {
          if (state.openTabIds.includes(tabId)) {
            return { homeTabId: tabId };
          }
          // 内置页按定义顺序；自定义面板保持相对顺序跟在后面
          const customs = state.openTabIds.filter(isHomeCustomPanelId);
          const builtins = HOME_DASHBOARD_PAGE_IDS.filter(
            (id) => id === tabId || state.openTabIds.includes(id),
          );
          return { openTabIds: [...builtins, ...customs], homeTabId: tabId };
        }),
      createCustomPanel: (label) => {
        const id = makeCustomPanelId();
        const trimmed = label.trim() || "Custom";
        set((state) => ({
          customPanels: {
            ...state.customPanels,
            [id]: {
              id,
              label: trimmed,
              createdAt: Date.now(),
              widgets: [],
            },
          },
          openTabIds: [...state.openTabIds, id],
          homeTabId: id,
        }));
        return id;
      },
      renameCustomPanel: (tabId, label) =>
        set((state) => {
          const prev = state.customPanels[tabId];
          if (!prev) return state;
          const trimmed = label.trim();
          if (!trimmed || trimmed === prev.label) return state;
          return {
            customPanels: {
              ...state.customPanels,
              [tabId]: { ...prev, label: trimmed },
            },
          };
        }),
      setCustomPanelLayout: (panelId, layout) =>
        set((state) => {
          const panel = state.customPanels[panelId];
          if (!panel) return state;
          const byId = new Map(layout.map((item) => [item.i, item]));
          let changed = false;
          const widgets = panel.widgets.map((widget) => {
            const item = byId.get(widget.id);
            if (!item) return widget;
            const scale = normalizeWidgetScale(
              widget.scale ?? DEFAULT_WIDGET_SCALE,
            );
            const def = getSmallComponent(widget.type);
            const nextSizeId =
              widget.type === MYSQL_OVERVIEW_TYPE
                ? (MYSQL_OVERVIEW_SIZES[0]?.id ?? "4x3")
                : widget.type === REDIS_OVERVIEW_TYPE
                  ? (REDIS_OVERVIEW_SIZES[0]?.id ?? "4x3")
                  : resolveWidgetSizeId(
                      widget.type,
                      def?.sizes,
                      // 用未缩放前的形态推断模式：除以 scale 再匹配
                      {
                        w: Math.max(1, Math.round(item.w / scale)),
                        h: Math.max(1, Math.round(item.h / scale)),
                      },
                      widget.sizeId,
                    );
            const nextLayout = layoutFromSizeScale(
              widget.type,
              nextSizeId,
              scale,
              {
                ...widget.layout,
                x: item.x,
                y: item.y,
              },
            );
            if (
              layoutsEqual(widget.layout, nextLayout) &&
              widget.layout.minW === nextLayout.minW &&
              widget.layout.minH === nextLayout.minH &&
              widget.layout.maxW === nextLayout.maxW &&
              widget.layout.maxH === nextLayout.maxH &&
              widget.sizeId === nextSizeId &&
              normalizeWidgetScale(widget.scale ?? DEFAULT_WIDGET_SCALE) ===
                scale
            ) {
              return widget;
            }
            changed = true;
            return {
              ...widget,
              layout: nextLayout,
              sizeId: nextSizeId,
              scale,
            };
          });
          if (!changed) return state;
          return {
            customPanels: {
              ...state.customPanels,
              [panelId]: { ...panel, widgets },
            },
          };
        }),
      addCustomPanelWidget: (panelId, type) => {
        const def = getSmallComponent(type);
        if (!def) return null;
        const id = makeWidgetInstanceId();
        set((state) => {
          const panel = state.customPanels[panelId];
          if (!panel) return state;
          const size = getDefaultSize(def);
          const scale = DEFAULT_WIDGET_SCALE;
          const scaled = applyWidgetScale(size, scale);
          const bounds = sizeBoundsWithScale(def.sizes);
          const origin = nextWidgetOrigin(panel.widgets, scaled.w);
          const widget: HomeCustomPanelWidget = {
            id,
            type,
            sizeId: size.id,
            scale,
            layout: {
              x: origin.x,
              y: origin.y,
              w: scaled.w,
              h: scaled.h,
              minW: bounds.minW,
              minH: bounds.minH,
              maxW: bounds.maxW,
              maxH: bounds.maxH,
            },
          };
          return {
            customPanels: {
              ...state.customPanels,
              [panelId]: {
                ...panel,
                widgets: [...panel.widgets, widget],
              },
            },
          };
        });
        return id;
      },
      setCustomPanelWidgetSize: (panelId, widgetId, sizeId) =>
        set((state) => {
          const panel = state.customPanels[panelId];
          if (!panel) return state;
          const idx = panel.widgets.findIndex((w) => w.id === widgetId);
          if (idx < 0) return state;
          const prev = panel.widgets[idx];
          const def = getSmallComponent(prev.type);
          if (!def?.sizes.length) return state;
          const preset = def.sizes.find(
            (s) => (s.id ?? `${s.h}x${s.w}`) === sizeId,
          );
          if (!preset) return state;
          const scale = normalizeWidgetScale(
            prev.scale ?? DEFAULT_WIDGET_SCALE,
          );
          const nextSizeId = preset.id ?? `${preset.h}x${preset.w}`;
          const nextLayout = layoutFromSizeScale(
            prev.type,
            nextSizeId,
            scale,
            prev.layout,
          );
          if (
            prev.sizeId === nextSizeId &&
            prev.layout.w === nextLayout.w &&
            prev.layout.h === nextLayout.h &&
            normalizeWidgetScale(prev.scale ?? DEFAULT_WIDGET_SCALE) === scale
          ) {
            return state;
          }
          const widgets = panel.widgets.slice();
          widgets[idx] = {
            ...prev,
            sizeId: nextSizeId,
            scale,
            layout: nextLayout,
          };
          return {
            customPanels: {
              ...state.customPanels,
              [panelId]: { ...panel, widgets },
            },
          };
        }),
      setCustomPanelWidgetScale: (panelId, widgetId, scale) =>
        set((state) => {
          const panel = state.customPanels[panelId];
          if (!panel) return state;
          const idx = panel.widgets.findIndex((w) => w.id === widgetId);
          if (idx < 0) return state;
          const prev = panel.widgets[idx];
          const nextScale = normalizeWidgetScale(scale);
          const nextLayout = layoutFromSizeScale(
            prev.type,
            prev.sizeId,
            nextScale,
            prev.layout,
          );
          if (
            normalizeWidgetScale(prev.scale ?? DEFAULT_WIDGET_SCALE) ===
              nextScale &&
            prev.layout.w === nextLayout.w &&
            prev.layout.h === nextLayout.h
          ) {
            return state;
          }
          const widgets = panel.widgets.slice();
          widgets[idx] = {
            ...prev,
            scale: nextScale,
            layout: nextLayout,
          };
          return {
            customPanels: {
              ...state.customPanels,
              [panelId]: { ...panel, widgets },
            },
          };
        }),
      setCustomPanelWidgetDataSource: (panelId, widgetId, dataSourceId) =>
        set((state) => {
          const panel = state.customPanels[panelId];
          if (!panel) return state;
          const idx = panel.widgets.findIndex((w) => w.id === widgetId);
          if (idx < 0) return state;
          const prev = panel.widgets[idx];
          const nextId = dataSourceId?.trim() || undefined;
          if (prev.dataSourceId === nextId) return state;
          const widgets = panel.widgets.slice();
          // 切换 Docker 实例时清空二级目标，避免串绑
          widgets[idx] = {
            ...prev,
            dataSourceId: nextId,
            target: undefined,
          };
          return {
            customPanels: {
              ...state.customPanels,
              [panelId]: { ...panel, widgets },
            },
          };
        }),
      setCustomPanelWidgetTarget: (panelId, widgetId, target) =>
        set((state) => {
          const panel = state.customPanels[panelId];
          if (!panel) return state;
          const idx = panel.widgets.findIndex((w) => w.id === widgetId);
          if (idx < 0) return state;
          const prev = panel.widgets[idx];
          const nextTarget = target ?? undefined;
          const same =
            (!prev.target && !nextTarget) ||
            (prev.target?.kind === "docker-container" &&
              nextTarget?.kind === "docker-container" &&
              prev.target.containerId === nextTarget.containerId) ||
            (prev.target?.kind === "docker-compose" &&
              nextTarget?.kind === "docker-compose" &&
              prev.target.composeProject === nextTarget.composeProject) ||
            (prev.target?.kind === "database-schema" &&
              nextTarget?.kind === "database-schema" &&
              prev.target.database === nextTarget.database);
          if (same) return state;
          const widgets = panel.widgets.slice();
          widgets[idx] = { ...prev, target: nextTarget };
          return {
            customPanels: {
              ...state.customPanels,
              [panelId]: { ...panel, widgets },
            },
          };
        }),
      removeCustomPanelWidget: (panelId, widgetId) =>
        set((state) => {
          const panel = state.customPanels[panelId];
          if (!panel) return state;
          if (!panel.widgets.some((w) => w.id === widgetId)) return state;
          return {
            customPanels: {
              ...state.customPanels,
              [panelId]: {
                ...panel,
                widgets: panel.widgets.filter((w) => w.id !== widgetId),
              },
            },
          };
        }),
      closeHomeTab: (tabId) =>
        set((state) => {
          if (!state.openTabIds.includes(tabId)) return state;
          const nextActive = pickActiveAfterClose(
            state.openTabIds,
            tabId,
            state.homeTabId,
          );
          const openTabIds = state.openTabIds.filter((id) => id !== tabId);
          let customPanels = state.customPanels;
          if (isHomeCustomPanelId(tabId) && customPanels[tabId]) {
            const { [tabId]: _removed, ...rest } = customPanels;
            customPanels = rest;
          }
          return {
            openTabIds,
            homeTabId: nextActive ?? state.homeTabId,
            customPanels,
          };
        }),
      refreshSignal: 0,
      triggerRefresh: () =>
        set((state) => ({ refreshSignal: state.refreshSignal + 1 })),
      setContainerSnapshot: ({ containers, loading, failureCount }) =>
        set((prev) => ({
          containers,
          loading,
          failureCount: prev.failureCount + failureCount,
          lastUpdatedAt: Date.now(),
        })),
      clearFailure: () => set({ failureCount: 0 }),
    }),
    {
      name: "omnipanel.dashboard.home-tab",
      // v9：移除内置「资源监控」页签（改由自定义面板小组件承担）
      // v10：MySQL 概览强制 5×3（高×宽），纠正早期误存的 w×h
      // v11：MySQL 概览改为 4×3
      // v12：全体小组件支持 1× / 2× 等比缩放（scale 字段）
      version: 12,
      // 只持久化 tab / 自定义面板元数据；容器列表仍走内存缓存
      partialize: (state) => ({
        homeTabId: state.homeTabId,
        openTabIds: state.openTabIds,
        customPanels: state.customPanels,
      }),
      // 每次 hydrate 都走 sanitize，避免同 version 下旧栅格尺寸卡死
      merge: (persisted, current) => {
        const raw = (persisted ?? {}) as {
          homeTabId?: unknown;
          openTabIds?: unknown;
          customPanels?: unknown;
        };
        const customPanels = sanitizeCustomPanels(raw.customPanels);
        const openTabIds = sanitizeOpenTabs(
          raw.openTabIds ?? current.openTabIds,
          customPanels,
        );
        const homeTabId =
          typeof raw.homeTabId === "string" &&
          isHomeDashboardTabId(raw.homeTabId) &&
          (openTabIds.length === 0 ||
            openTabIds.includes(raw.homeTabId as HomeDashboardTabId))
            ? (raw.homeTabId as HomeDashboardTabId)
            : (openTabIds[0] ?? current.homeTabId ?? "board");
        return {
          ...current,
          homeTabId,
          openTabIds,
          customPanels,
        };
      },
      migrate: (persisted) => {
        const raw = (persisted ?? {}) as {
          homeTabId?: unknown;
          openTabIds?: unknown;
          customPanels?: unknown;
        };
        const customPanels = sanitizeCustomPanels(raw.customPanels);
        const openTabIds = sanitizeOpenTabs(
          raw.openTabIds ??
            (typeof raw.homeTabId === "string" && isHomeBuiltinPageId(raw.homeTabId)
              ? [raw.homeTabId, ...DEFAULT_OPEN_TABS.filter((id) => id !== raw.homeTabId)]
              : DEFAULT_OPEN_TABS),
          customPanels,
        );
        const homeTabId =
          typeof raw.homeTabId === "string" &&
          isHomeDashboardTabId(raw.homeTabId) &&
          (openTabIds.length === 0 || openTabIds.includes(raw.homeTabId as HomeDashboardTabId))
            ? (raw.homeTabId as HomeDashboardTabId)
            : (openTabIds[0] ?? "board");
        return { homeTabId, openTabIds, customPanels };
      },
    },
  ),
);

/** 纯读容器快照（无订阅），给非组件上下文用 */
export function getDashboardContainerSnapshot(): DashboardContainerState {
  const s = useDashboardStore.getState();
  return {
    containers: s.containers,
    loading: s.loading,
    failureCount: s.failureCount,
    lastUpdatedAt: s.lastUpdatedAt,
  };
}

export { CREATE_CUSTOM_MENU_ID };
