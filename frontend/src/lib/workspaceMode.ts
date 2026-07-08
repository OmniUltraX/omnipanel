/** 工作区展示形态（非全屏嵌入态） */
export type EmbeddedWorkspaceMode = "hidden" | "taskbar" | "thumbnail" | "half";

/** 应用级工作区模式 */
export type WorkspaceMode =
  | EmbeddedWorkspaceMode
  | "fullscreen"
  | "home";

/** 低于等于此高度视为隐藏 */
export const WS_HEIGHT_HIDDEN_MAX = 20;
/** task-bar 固定展示高度（px） */
export const WS_HEIGHT_TASKBAR_MAX = 40;
/** 超过视口此比例高度时进入 split-window */
export const WS_SPLIT_WINDOW_HEIGHT_RATIO = 0.3;
/** 缩略图模式最低高度（px）— 两态 UI 下与 taskbar 分界 */
export const WS_HEIGHT_THUMBNAIL_MIN = WS_HEIGHT_TASKBAR_MAX + 1;
/** 缩略图模式最高高度（px）：超过即进入 split-window（half） */
export const WS_HEIGHT_THUMBNAIL_MAX = WS_HEIGHT_TASKBAR_MAX;

export const WS_DEFAULT_HEIGHT: Record<EmbeddedWorkspaceMode, number> = {
  hidden: 0,
  taskbar: WS_HEIGHT_TASKBAR_MAX,
  thumbnail: WS_HEIGHT_TASKBAR_MAX,
  half: 320,
};

/** 半屏默认占视口高度比例（全屏拖出、状态栏展开等） */
export const WS_HALF_HEIGHT_RATIO = 0.5;

/** 底部工作区可拖拽的最大高度占窗口高度比例 */
export const WS_BOTTOM_PANEL_MAX_HEIGHT_RATIO = 0.95;

/** 将 split-window 高度限制在视口允许范围内 */
export function clampSplitWindowHeightPx(
  heightPx: number,
  viewportHeight = window.innerHeight,
): number {
  const min = splitWindowMinHeightPx(viewportHeight);
  const max = Math.floor(viewportHeight * WS_BOTTOM_PANEL_MAX_HEIGHT_RATIO);
  return Math.max(min, Math.min(max, Math.round(heightPx)));
}

/** 按视口比例计算 split-window 目标高度（px） */
export function splitWindowHeightFromRatio(
  ratio: number,
  viewportHeight = window.innerHeight,
): number {
  return clampSplitWindowHeightPx(ratio * viewportHeight, viewportHeight);
}

/** 将像素高度转为视口比例（用于窗口 resize 时等比缩放） */
export function splitWindowHeightRatio(
  heightPx: number,
  viewportHeight = window.innerHeight,
): number {
  if (viewportHeight <= 0) return WS_HALF_HEIGHT_RATIO;
  return clampSplitWindowHeightPx(heightPx, viewportHeight) / viewportHeight;
}

/** split-window 与 task-bar 分界高度（px）：视口高度的 30% */
export function splitWindowMinHeightPx(viewportHeight = window.innerHeight): number {
  return Math.max(
    WS_HEIGHT_TASKBAR_MAX + 1,
    Math.floor(viewportHeight * WS_SPLIT_WINDOW_HEIGHT_RATIO),
  );
}

/** 当前视口下半屏目标高度（px） */
export function halfHeightPx(viewportHeight = window.innerHeight): number {
  return Math.max(
    splitWindowMinHeightPx(viewportHeight),
    Math.floor(viewportHeight * WS_HALF_HEIGHT_RATIO),
  );
}

export function isEmbeddedWorkspaceMode(
  mode: WorkspaceMode,
): mode is EmbeddedWorkspaceMode {
  return mode === "hidden" || mode === "taskbar" || mode === "thumbnail" || mode === "half";
}

/** 根据像素高度判定嵌入态模式（提交态） */
export function modeFromHeight(
  px: number,
  _currentMode?: EmbeddedWorkspaceMode,
): EmbeddedWorkspaceMode {
  const h = Math.max(0, Math.round(px));
  if (h <= WS_HEIGHT_HIDDEN_MAX) return "hidden";
  if (h < splitWindowMinHeightPx()) return "taskbar";
  return "half";
}

/**
 * 拖拽进行中的实时模式判定（仅切换渲染形态，不吸附高度）。
 * 拖拽中不进入 hidden，折叠在松手时判定。
 */
export function dragModeFromHeight(
  px: number,
  _currentMode?: EmbeddedWorkspaceMode,
): EmbeddedWorkspaceMode {
  const h = Math.max(0, Math.round(px));
  if (h < splitWindowMinHeightPx()) return "taskbar";
  return "half";
}

/** 松手提交：解析模式与规范高度（task-bar 吸附 40px，split-window 保留用户高度）。 */
export function resolveEmbeddedHeight(heightPx: number): {
  mode: EmbeddedWorkspaceMode;
  height: number;
} {
  const h = Math.max(0, Math.round(heightPx));
  if (h <= WS_HEIGHT_HIDDEN_MAX) {
    return { mode: "hidden", height: 0 };
  }
  if (h < splitWindowMinHeightPx()) {
    return { mode: "taskbar", height: WS_HEIGHT_TASKBAR_MAX };
  }
  return { mode: "half", height: h };
}

/** 按形态规范化面板高度 */
export function normalizeWorkspaceHeight(
  px: number,
  mode: EmbeddedWorkspaceMode,
): number {
  const h = Math.max(0, Math.round(px));
  if (mode === "hidden") return 0;
  if (mode === "taskbar" || mode === "thumbnail") return WS_HEIGHT_TASKBAR_MAX;
  return Math.max(h, splitWindowMinHeightPx());
}

export function defaultHeightForMode(mode: EmbeddedWorkspaceMode): number {
  if (mode === "half") return halfHeightPx();
  return WS_DEFAULT_HEIGHT[mode];
}

/** 供 App/WorkspaceHost 使用的粗粒度 CSS 状态 */
export function workspaceShellState(mode: WorkspaceMode): "full" | "half" | "off" {
  if (mode === "fullscreen" || mode === "home") return "full";
  if (mode === "hidden") return "off";
  return "half";
}

/** 用户偏好的底部工作区展示形态（状态栏切换） */
export type WorkspaceDisplayPreference = "split-window" | "task-bar";

export function embeddedModeToDisplayPreference(
  mode: EmbeddedWorkspaceMode,
): WorkspaceDisplayPreference {
  return mode === "taskbar" || mode === "thumbnail" ? "task-bar" : "split-window";
}
