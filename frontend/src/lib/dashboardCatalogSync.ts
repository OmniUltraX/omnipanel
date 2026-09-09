/**
 * 主窗 ↔ 快捷启动：看板/自定义面板目录同步。
 * 自定义面板只存在于主窗 persist，QL 独立 WebView 需事件拉取。
 */
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauriRuntime } from "./isTauriRuntime";
import {
  isHomeCustomPanelId,
  useDashboardStore,
} from "../modules/workspace/useDashboardStore";

export const DASHBOARD_CATALOG_REQUEST_EVENT = "omnipanel:dashboard-catalog-request";
export const DASHBOARD_CATALOG_SYNC_EVENT = "omnipanel:dashboard-catalog-sync";

export type DashboardCatalogEntry = {
  tabId: string;
  /** 自定义面板名；内置 `board` 可省略，由 QL i18n */
  label?: string;
  kind: "builtin" | "custom";
  widgetCount?: number;
};

export type DashboardCatalogPayload = {
  entries: DashboardCatalogEntry[];
  /** 当前激活的首页 tab */
  activeTabId?: string;
};

export function collectDashboardCatalog(): DashboardCatalogPayload {
  const { customPanels, homeTabId } = useDashboardStore.getState();
  const entries: DashboardCatalogEntry[] = [
    { tabId: "board", kind: "builtin" },
  ];
  const customs = Object.values(customPanels)
    .filter((p) => isHomeCustomPanelId(p.id))
    .sort((a, b) => a.createdAt - b.createdAt || a.label.localeCompare(b.label));
  for (const panel of customs) {
    entries.push({
      tabId: panel.id,
      label: panel.label,
      kind: "custom",
      widgetCount: panel.widgets.length,
    });
  }
  return { entries, activeTabId: homeTabId };
}

function isCatalogPayload(value: unknown): value is DashboardCatalogPayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.entries)) return false;
  return v.entries.every((item) => {
    if (!item || typeof item !== "object") return false;
    const e = item as Record<string, unknown>;
    return (
      typeof e.tabId === "string" &&
      (e.kind === "builtin" || e.kind === "custom") &&
      (e.label === undefined || typeof e.label === "string") &&
      (e.widgetCount === undefined || typeof e.widgetCount === "number")
    );
  });
}

export async function broadcastDashboardCatalog(
  payload: DashboardCatalogPayload = collectDashboardCatalog(),
): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await emit(DASHBOARD_CATALOG_SYNC_EVENT, payload);
  } catch (e) {
    console.warn("[dashboardCatalogSync] broadcast failed", e);
  }
}

export async function requestDashboardCatalog(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await emit(DASHBOARD_CATALOG_REQUEST_EVENT);
  } catch (e) {
    console.warn("[dashboardCatalogSync] request failed", e);
  }
}

/** 主窗：响应目录请求；面板增删改时也可主动广播。 */
export function initDashboardCatalogPublisher(): () => void {
  if (!isTauriRuntime()) return () => {};

  void broadcastDashboardCatalog();

  let unlistenReq: UnlistenFn | undefined;
  void listen(DASHBOARD_CATALOG_REQUEST_EVENT, () => {
    void broadcastDashboardCatalog();
  }).then((fn) => {
    unlistenReq = fn;
  });

  const unsubStore = useDashboardStore.subscribe((state, prev) => {
    if (state.customPanels === prev.customPanels && state.homeTabId === prev.homeTabId) {
      return;
    }
    void broadcastDashboardCatalog(collectDashboardCatalog());
  });

  return () => {
    unsubStore();
    unlistenReq?.();
  };
}

/** 快捷启动窗：监听目录广播。 */
export function initDashboardCatalogSubscriber(
  onCatalog: (payload: DashboardCatalogPayload) => void,
): () => void {
  if (!isTauriRuntime()) return () => {};

  let unlisten: UnlistenFn | undefined;
  void listen<DashboardCatalogPayload>(DASHBOARD_CATALOG_SYNC_EVENT, (event) => {
    if (!isCatalogPayload(event.payload)) return;
    onCatalog(event.payload);
  }).then((fn) => {
    unlisten = fn;
  });

  void requestDashboardCatalog();

  return () => {
    unlisten?.();
  };
}
