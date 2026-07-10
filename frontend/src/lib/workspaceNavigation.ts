import type { NavigateFunction } from "react-router-dom";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useTerminalLeftPanelStore } from "../modules/terminal/terminalLeftPanelStore";
import { useBottomPanelStore } from "../stores/bottomPanelStore";
import { DEFAULT_WORKSPACE, useWorkspaceStore } from "../stores/workspaceStore";
import { useDashboardStore } from "../modules/workspace/useDashboardStore";
import {
  DASHBOARD_PATH,
  MODULE_PATHS,
  WORKSPACE_PATHS,
  isDashboardPath,
  isWorkspacePath,
} from "./paths";
import {
  isWorkspacePoppedOut,
  useWorkspaceWindowStore,
} from "../stores/workspaceWindowStore";
import { parseWorkspaceWindowParams, workspaceWindowLabel } from "./workspaceWindow";
import { isTauriRuntime } from "./isTauriRuntime";

const MAIN_WINDOW_LABEL = "main";

let chromeIconTransition = false;

/**
 * 核实独立窗口是否真的还活着；死标记一律清掉。
 * 返回 true 表示已成功聚焦独立窗口。
 */
export async function tryFocusLiveWorkspaceWindow(id: string): Promise<boolean> {
  if (!isWorkspacePoppedOut(id)) return false;
  if (!isTauriRuntime()) {
    useWorkspaceWindowStore.getState().clearPoppedOut(id);
    return false;
  }
  try {
    const existing = await WebviewWindow.getByLabel(workspaceWindowLabel(id));
    if (!existing) {
      useWorkspaceWindowStore.getState().clearPoppedOut(id);
      return false;
    }
    const target = useWorkspaceStore.getState().workspaces.find((w) => w.id === id);
    await existing.unminimize().catch(() => {});
    await existing.show().catch(() => {});
    await existing.setFocus().catch(() => {});
    useWorkspaceWindowStore.getState().markPoppedOut(id);
    void existing.setTitle(target?.name ?? id).catch(() => {});
    return true;
  } catch {
    useWorkspaceWindowStore.getState().clearPoppedOut(id);
    return false;
  }
}

/** 聚焦主窗口（工程工作区 / 首页入口）。 */
export async function focusMainWindow(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const main = await WebviewWindow.getByLabel(MAIN_WINDOW_LABEL);
    if (!main) return;
    await main.unminimize().catch(() => {});
    await main.show().catch(() => {});
    await main.setFocus().catch(() => {});
  } catch {
    // ignore
  }
}

function dispatchNavigate(path: string, navigate?: NavigateFunction): void {
  if (navigate) {
    if (!isWorkspacePath(path)) {
      useWorkspaceStore.getState().setActivePath(path);
    }
    navigate(path, { replace: true });
    return;
  }
  window.dispatchEvent(
    new CustomEvent("omnipanel-navigate", {
      detail: { path },
    }),
  );
}

function doEnterEngineeringWorkspaceFullscreen(
  id: string,
  navigate?: NavigateFunction,
): void {
  const targetPath = WORKSPACE_PATHS.detail(id);
  const store = useWorkspaceStore.getState();
  const bottom = useBottomPanelStore.getState();
  if (
    store.workspace.id === id &&
    bottom.isFullscreen &&
    window.location.pathname === targetPath
  ) {
    bottom.clearDeferExitFullscreen();
    return;
  }
  store.switchWorkspace(id);
  bottom.clearDeferExitFullscreen();
  // 先进入全屏再改路由，避免 /workspace/:id 短暂处于嵌入 taskbar 态（主区空白 + 底栏）
  bottom.enterWorkspaceFullscreen();
  if (window.location.pathname !== targetPath) {
    dispatchNavigate(targetPath, navigate);
  }
}

/**
 * 任意窗口（主窗 / 独立窗）统一的工作区切换：
 * - 已弹出独立窗 → 聚焦该窗
 * - 主窗承载 → 聚焦主窗并进入该工作区全屏
 */
export async function selectWorkspaceUniversally(
  id: string,
  navigate?: NavigateFunction,
): Promise<void> {
  if (isWorkspacePoppedOut(id)) {
    useWorkspaceStore.getState().switchWorkspace(id);
    useBottomPanelStore.getState().requestCollapse();
    await tryFocusLiveWorkspaceWindow(id);
    return;
  }
  // 同步进入全屏再 await，避免 focusMainWindow 让出事件循环后 defer/expand 抢先改状态
  doEnterEngineeringWorkspaceFullscreen(id, navigate);
  await focusMainWindow();
}

/** 任意窗口统一回首页：聚焦主窗并回到看板。 */
export async function goHomeUniversally(navigate?: NavigateFunction): Promise<void> {
  goWorkspaceHome(navigate);
  await focusMainWindow();
}

/**
 * 模块页状态栏：仅切换主窗「当前工作区」上下文，不进入工程工作区全屏。
 * - 已弹出独立 OS 窗 → 更新选中态、收起主窗底栏、聚焦该窗
 * - 主窗承载 → 切换工作区并按偏好展开 taskbar / 半屏
 */
export async function selectWorkspaceForMainContext(
  id: string,
  navigate?: NavigateFunction,
): Promise<void> {
  if (isWorkspacePoppedOut(id)) {
    useWorkspaceStore.getState().switchWorkspace(id);
    useBottomPanelStore.getState().requestCollapse();
    await tryFocusLiveWorkspaceWindow(id);
    return;
  }
  const activePath = useWorkspaceStore.getState().activePath;
  // 看板 / 工程工作区路由：只能进入全屏或独立窗，禁止嵌入 taskbar
  if (isDashboardPath(activePath) || isWorkspacePath(activePath)) {
    void selectWorkspaceUniversally(id, navigate);
    return;
  }
  await focusMainWindow();
  useWorkspaceStore.getState().switchWorkspace(id);
  useBottomPanelStore.getState().requestExpand();
}

/**
 * 独立工作区 OS 窗口 / 全屏工程工作区面板：左上角始终绑定本窗工作区；
 * 选择其他工作区时仅聚焦目标（主窗或其它独立窗），不改变当前窗口内容。
 */
export async function selectWorkspaceFromBoundContext(
  targetId: string,
  boundWorkspaceId: string,
  navigate?: NavigateFunction,
): Promise<void> {
  if (targetId === boundWorkspaceId) return;
  if (isWorkspacePoppedOut(targetId)) {
    await tryFocusLiveWorkspaceWindow(targetId);
    return;
  }
  if (isDetachedWorkspaceWindow()) {
    await focusMainWindow();
    useWorkspaceStore.getState().switchWorkspace(targetId);
    useBottomPanelStore.getState().requestExpand();
    return;
  }
  void selectWorkspaceUniversally(targetId, navigate);
}

/** 嵌入态顶栏（历史）：与状态栏一致，不进入全屏工作区路由。 */
export function switchEmbeddedWorkspace(id: string, navigate?: NavigateFunction): void {
  void selectWorkspaceForMainContext(id, navigate);
}

/** 进入工程工作区全屏（/workspace/:id） */
export function enterEngineeringWorkspaceFullscreen(
  id: string,
  navigate?: NavigateFunction,
): void {
  void selectWorkspaceUniversally(id, navigate);
}

/** 退出工程工作区全屏，恢复嵌入态并回到功能页或看板 */
export function exitEngineeringWorkspaceFullscreen(
  navigate?: NavigateFunction,
): void {
  const bottom = useBottomPanelStore.getState();
  if (!bottom.isFullscreen) return;
  const activePath = useWorkspaceStore.getState().activePath;
  const target = isWorkspacePath(activePath) ? DASHBOARD_PATH : activePath;
  bottom.requestDeferExitFullscreen(target, "feature");
  dispatchNavigate(target, navigate);
}

export function pickMainWindowWorkspaceId(preferredId?: string): string {
  const { workspaces, workspace } = useWorkspaceStore.getState();
  const candidates = [
    preferredId,
    workspace.id,
    DEFAULT_WORKSPACE.id,
    ...workspaces.map((w) => w.id),
  ].filter((id): id is string => Boolean(id));
  for (const id of candidates) {
    if (!isWorkspacePoppedOut(id) && workspaces.some((w) => w.id === id)) {
      return id;
    }
  }
  return DEFAULT_WORKSPACE.id;
}

/** 进入看板首页（/dashboard）；同时切到主窗口仍可承载的工作区 */
export function goWorkspaceHome(navigate?: NavigateFunction): void {
  const nextId = pickMainWindowWorkspaceId();
  useWorkspaceStore.getState().switchWorkspace(nextId);
  const bottom = useBottomPanelStore.getState();
  if (bottom.isFullscreen) {
    bottom.requestDeferExitFullscreen(DASHBOARD_PATH, "home");
  } else if (isWorkspacePoppedOut(nextId)) {
    bottom.requestCollapse();
  }
  dispatchNavigate(DASHBOARD_PATH, navigate);
}

/** 当前 WebView 是否为工作区独立窗口 */
export function isDetachedWorkspaceWindow(): boolean {
  return parseWorkspaceWindowParams() !== null;
}

export function toggleWorkspaceFromChromeIcon(
  navigate?: NavigateFunction,
  currentPath?: string,
): void {
  if (chromeIconTransition) return;
  chromeIconTransition = true;
  try {
    if (currentPath && isDashboardPath(currentPath)) {
      useDashboardStore.getState().triggerRefresh();
      return;
    }
    const bottom = useBottomPanelStore.getState();
    const mode = bottom.workspaceMode;
    if (mode === "fullscreen" || mode === "hidden" || mode === "thumbnail") {
      void goHomeUniversally(navigate);
      return;
    }
    const id = useWorkspaceStore.getState().workspace.id;
    void selectWorkspaceUniversally(id, navigate);
  } finally {
    queueMicrotask(() => {
      chromeIconTransition = false;
    });
  }
}

export function navigateToWorkspace(
  id: string,
  navigate?: NavigateFunction,
): void {
  void selectWorkspaceUniversally(id, navigate);
}

export function toggleEngineeringWorkspaceFullscreen(
  navigate?: NavigateFunction,
): void {
  const bottom = useBottomPanelStore.getState();
  if (bottom.isFullscreen) {
    exitEngineeringWorkspaceFullscreen(navigate);
    return;
  }
  const id = useWorkspaceStore.getState().workspace.id;
  void selectWorkspaceUniversally(id, navigate);
}

export function leaveWorkspaceHomeForFeature(): void {
  useBottomPanelStore.getState().leaveFullscreenForFeature();
}

export function navigateToSshManagement(navigate: NavigateFunction): void {
  useTerminalLeftPanelStore.getState().focusSsh();
  navigateToFeature(MODULE_PATHS.terminal, navigate);
}

export function navigateToFeature(path: string, navigate: NavigateFunction): void {
  if (window.location.pathname === path) {
    useWorkspaceStore.getState().setActivePath(path);
    return;
  }
  useWorkspaceStore.getState().setActivePath(path);
  const bottom = useBottomPanelStore.getState();
  if (bottom.isFullscreen) {
    bottom.requestDeferExitFullscreen(path, "feature");
    navigate(path);
    return;
  }
  navigate(path);
}
