import { invoke } from "@tauri-apps/api/core";
import { cursorPosition } from "@tauri-apps/api/window";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { workspaceIdFromLabel } from "./workspaceWindow";

export async function resolvePhysicalScreenPoint(
  screenX?: number,
  screenY?: number,
): Promise<{ x: number; y: number }> {
  try {
    const pos = await cursorPosition();
    return { x: pos.x, y: pos.y };
  } catch {
    const dpr = window.devicePixelRatio || 1;
    return {
      x: (screenX ?? 0) * dpr,
      y: (screenY ?? 0) * dpr,
    };
  }
}

export function resolveTargetWorkspaceId(windowLabel: string): string | null {
  if (windowLabel === "main") {
    return useWorkspaceStore.getState().workspace.id;
  }
  return workspaceIdFromLabel(windowLabel);
}

/** 跨窗落点对应的工作区 id（主窗落点用源工作区，避免弹出后主窗当前选中不一致） */
export function resolveTargetWorkspaceIdForTransfer(
  targetLabel: string,
  sourceWorkspaceId: string,
): string | null {
  if (targetLabel === "main") {
    return sourceWorkspaceId;
  }
  return workspaceIdFromLabel(targetLabel) ?? sourceWorkspaceId;
}

/** 屏幕坐标 → 当前 WebView 内 client 坐标（跨窗落点命中检测）。 */
export function screenPointToClient(
  screenX: number,
  screenY: number,
): { clientX: number; clientY: number } {
  return {
    clientX: screenX - window.screenX,
    clientY: screenY - window.screenY,
  };
}

export async function findWindowLabelAtScreenPoint(
  screenX?: number,
  screenY?: number,
  log?: (message: string) => void,
): Promise<string | null> {
  const { x, y } = await resolvePhysicalScreenPoint(screenX, screenY);
  try {
    const label = await invoke<string | null>("window_label_at_screen_point", { x, y });
    if (label) {
      log?.(`hit invoke label=${label} @${x},${y}`);
      return label;
    }
  } catch (e) {
    log?.(`invoke hit-test failed: ${e}`);
  }

  const wins = await getAllWebviewWindows();
  let hit: string | null = null;
  for (const w of wins) {
    try {
      const [pos, size] = await Promise.all([w.outerPosition(), w.outerSize()]);
      const left = pos.x;
      const top = pos.y;
      const right = left + size.width;
      const bottom = top + size.height;
      if (x >= left && x < right && y >= top && y < bottom) {
        hit = w.label;
      }
    } catch {
      // ignore
    }
  }
  log?.(`hit fallback label=${hit ?? "none"} @${x},${y}`);
  return hit;
}
