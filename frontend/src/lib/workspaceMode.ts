/** 工作区展示形态（非全屏嵌入态） */
export type EmbeddedWorkspaceMode = "hidden" | "taskbar" | "thumbnail" | "half";

/** 应用级工作区模式 */
export type WorkspaceMode =
  | EmbeddedWorkspaceMode
  | "fullscreen"
  | "home";

export const WS_HEIGHT_HIDDEN_MAX = 20;
/** 任务栏固定高度（px），与 shell 顶栏 --topbar-h 一致 */
export const WS_HEIGHT_TASKBAR_FIXED = 44;
/** 缩略图模式最低高度（px） */
export const WS_HEIGHT_THUMBNAIL_MIN = 100;
/** 缩略图模式最高高度（px）：超过即进入半屏 */
export const WS_HEIGHT_THUMBNAIL_MAX = 200;

export const WS_DEFAULT_HEIGHT: Record<EmbeddedWorkspaceMode, number> = {
  hidden: 0,
  taskbar: WS_HEIGHT_TASKBAR_FIXED,
  thumbnail: 150,
  half: 320,
};

export function isEmbeddedWorkspaceMode(
  mode: WorkspaceMode,
): mode is EmbeddedWorkspaceMode {
  return mode === "hidden" || mode === "taskbar" || mode === "thumbnail" || mode === "half";
}

export function modeFromHeight(
  px: number,
  currentMode?: EmbeddedWorkspaceMode,
): EmbeddedWorkspaceMode {
  const h = Math.max(0, Math.round(px));
  if (h <= WS_HEIGHT_HIDDEN_MAX) return "hidden";

  // taskbar 固定 44px：向上拖过即进入缩略图，不存在 45–99 中间态
  if (currentMode === "taskbar") {
    if (h > WS_HEIGHT_TASKBAR_FIXED) {
      return h <= WS_HEIGHT_THUMBNAIL_MAX ? "thumbnail" : "half";
    }
    return "taskbar";
  }

  if (currentMode === "thumbnail" || currentMode === "half") {
    if (h < WS_HEIGHT_THUMBNAIL_MIN) return "taskbar";
    if (h <= WS_HEIGHT_THUMBNAIL_MAX) return "thumbnail";
    return "half";
  }

  if (h <= WS_HEIGHT_TASKBAR_FIXED) return "taskbar";
  if (h < WS_HEIGHT_THUMBNAIL_MIN) return "taskbar";
  if (h <= WS_HEIGHT_THUMBNAIL_MAX) return "thumbnail";
  return "half";
}

/**
 * 拖拽进行中的实时模式判定。
 *
 * 仅用于切换渲染形态（taskbar / thumbnail / half），不会触发任何面板吸附，
 * 因此拖拽全程跟手、无回弹。taskbar ↔ thumbnail 之间使用滞回阈值
 * （上行 76px 才升级、下行 68px 才降级），避免在临界点附近 UI 抖动。
 * 拖拽中永不返回 hidden —— 是否折叠在松手时按真实像素判定。
 */
export function dragModeFromHeight(
  px: number,
  currentMode?: EmbeddedWorkspaceMode,
): EmbeddedWorkspaceMode {
  const h = Math.max(0, Math.round(px));
  const TASKBAR_TO_THUMBNAIL = 76;
  const THUMBNAIL_TO_TASKBAR = 68;

  if (currentMode === "taskbar") {
    if (h > TASKBAR_TO_THUMBNAIL) {
      return h <= WS_HEIGHT_THUMBNAIL_MAX ? "thumbnail" : "half";
    }
    return "taskbar";
  }

  if (currentMode === "thumbnail" || currentMode === "half") {
    if (h < THUMBNAIL_TO_TASKBAR) return "taskbar";
    return h <= WS_HEIGHT_THUMBNAIL_MAX ? "thumbnail" : "half";
  }

  if (h <= (WS_HEIGHT_TASKBAR_FIXED + WS_HEIGHT_THUMBNAIL_MIN) / 2) return "taskbar";
  return h <= WS_HEIGHT_THUMBNAIL_MAX ? "thumbnail" : "half";
}

/** 按形态规范化面板高度 */
export function normalizeWorkspaceHeight(
  px: number,
  mode: EmbeddedWorkspaceMode,
): number {
  const rounded = Math.max(0, Math.round(px));
  if (mode === "hidden") return 0;
  if (mode === "taskbar") return WS_HEIGHT_TASKBAR_FIXED;
  if (mode === "thumbnail") {
    return Math.max(WS_HEIGHT_THUMBNAIL_MIN, Math.min(rounded, WS_HEIGHT_THUMBNAIL_MAX));
  }
  return rounded;
}

export function defaultHeightForMode(mode: EmbeddedWorkspaceMode): number {
  return WS_DEFAULT_HEIGHT[mode];
}

/** 供 App/WorkspaceHost 使用的粗粒度 CSS 状态 */
export function workspaceShellState(mode: WorkspaceMode): "full" | "half" | "off" {
  if (mode === "fullscreen" || mode === "home") return "full";
  if (mode === "hidden") return "off";
  return "half";
}
