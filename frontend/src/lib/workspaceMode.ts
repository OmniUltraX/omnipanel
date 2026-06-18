/** 工作区展示形态（非全屏嵌入态） */
export type EmbeddedWorkspaceMode = "hidden" | "taskbar" | "thumbnail" | "half";

/** 应用级工作区模式 */
export type WorkspaceMode =
  | EmbeddedWorkspaceMode
  | "fullscreen"
  | "home";

/** 低于等于此高度视为隐藏 */
export const WS_HEIGHT_HIDDEN_MAX = 20;
/** 任务栏最大高度（px），与 shell 顶栏 --topbar-h 一致 */
export const WS_HEIGHT_TASKBAR_MAX = 44;
/** @deprecated 使用 WS_HEIGHT_TASKBAR_MAX */
export const WS_HEIGHT_TASKBAR_FIXED = WS_HEIGHT_TASKBAR_MAX;
/** 缩略图模式最低高度（px） */
export const WS_HEIGHT_THUMBNAIL_MIN = 100;
/** 缩略图模式最高高度（px）：超过即进入半屏 */
export const WS_HEIGHT_THUMBNAIL_MAX = 200;

export const WS_DEFAULT_HEIGHT: Record<EmbeddedWorkspaceMode, number> = {
  hidden: 0,
  taskbar: WS_HEIGHT_TASKBAR_MAX,
  thumbnail: 150,
  half: 320,
};

/** 半屏默认占视口高度比例（全屏拖出、状态栏展开等） */
export const WS_HALF_HEIGHT_RATIO = 0.5;

/** 当前视口下半屏目标高度（px） */
export function halfHeightPx(viewportHeight = window.innerHeight): number {
  return Math.max(
    WS_HEIGHT_THUMBNAIL_MAX + 1,
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
  if (h <= WS_HEIGHT_TASKBAR_MAX) return "taskbar";
  if (h <= WS_HEIGHT_THUMBNAIL_MAX) return "thumbnail";
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
  if (h <= WS_HEIGHT_TASKBAR_MAX) return "taskbar";
  if (h <= WS_HEIGHT_THUMBNAIL_MAX) return "thumbnail";
  return "half";
}

/**
 * 松手提交：解析模式与规范高度。
 * >44 且 <100 直接吸附到缩略图 100px。
 */
export function resolveEmbeddedHeight(heightPx: number): {
  mode: EmbeddedWorkspaceMode;
  height: number;
} {
  const h = Math.max(0, Math.round(heightPx));
  if (h <= WS_HEIGHT_HIDDEN_MAX) {
    return { mode: "hidden", height: 0 };
  }
  if (h <= WS_HEIGHT_TASKBAR_MAX) {
    return { mode: "taskbar", height: WS_HEIGHT_TASKBAR_MAX };
  }
  if (h < WS_HEIGHT_THUMBNAIL_MIN) {
    return { mode: "thumbnail", height: WS_HEIGHT_THUMBNAIL_MIN };
  }
  if (h <= WS_HEIGHT_THUMBNAIL_MAX) {
    return { mode: "thumbnail", height: h };
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
  if (mode === "taskbar") return WS_HEIGHT_TASKBAR_MAX;
  if (mode === "thumbnail") {
    if (h < WS_HEIGHT_THUMBNAIL_MIN) return WS_HEIGHT_THUMBNAIL_MIN;
    return Math.min(h, WS_HEIGHT_THUMBNAIL_MAX);
  }
  return Math.max(h, WS_HEIGHT_THUMBNAIL_MAX + 1);
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
