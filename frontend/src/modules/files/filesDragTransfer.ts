import type { FileClipboardItem } from "../../stores/filesClipboardStore";

/** 应用内文件跨连接拖拽 MIME（部分 WebView 会丢自定义类型，故同时用模块变量兜底）。 */
export const FILES_DRAG_MIME = "application/x-omnipanel-files";

export type FilesDragPayload = {
  connectionId: string;
  items: FileClipboardItem[];
  /** 拖拽固定为 copy；剪切请用剪贴板 */
  mode: "copy";
};

/** 拖到未激活 Tab 后，等目标面板激活再入队 */
export type PendingFilesTabDrop = {
  destConnectionId: string;
  items: FileClipboardItem[];
  queuedAt: number;
};

let activePayload: FilesDragPayload | null = null;
let pendingTabDrop: PendingFilesTabDrop | null = null;

export function setActiveFilesDrag(payload: FilesDragPayload | null) {
  activePayload = payload;
}

export function getActiveFilesDrag(): FilesDragPayload | null {
  return activePayload;
}

export function parseFilesDrag(dataTransfer: DataTransfer | null): FilesDragPayload | null {
  if (!dataTransfer) return activePayload;
  const raw = dataTransfer.getData(FILES_DRAG_MIME) || dataTransfer.getData("text/plain");
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as FilesDragPayload;
      if (parsed?.connectionId && Array.isArray(parsed.items) && parsed.items.length > 0) {
        return parsed;
      }
    } catch {
      /* ignore */
    }
  }
  return activePayload;
}

export function hasFilesDrag(dataTransfer: DataTransfer | null): boolean {
  if (activePayload) return true;
  if (!dataTransfer) return false;
  const types = Array.from(dataTransfer.types ?? []);
  // 系统拖放常带 Files + text/plain，不能把 text/plain 当成应用内拖拽
  if (types.includes("Files")) {
    return types.includes(FILES_DRAG_MIME);
  }
  return types.includes(FILES_DRAG_MIME) || types.includes("text/plain");
}

export function writeFilesDrag(dataTransfer: DataTransfer, payload: FilesDragPayload) {
  setActiveFilesDrag(payload);
  const json = JSON.stringify(payload);
  dataTransfer.effectAllowed = "copy";
  try {
    dataTransfer.setData(FILES_DRAG_MIME, json);
  } catch {
    /* some WebViews reject custom MIME */
  }
  try {
    dataTransfer.setData("text/plain", json);
  } catch {
    /* ignore */
  }
}

export function clearFilesDrag() {
  activePayload = null;
}

export function queuePendingFilesTabDrop(drop: Omit<PendingFilesTabDrop, "queuedAt">) {
  pendingTabDrop = { ...drop, queuedAt: Date.now() };
  window.dispatchEvent(
    new CustomEvent("omnipanel-files-tab-drop", {
      detail: { destConnectionId: drop.destConnectionId },
    }),
  );
}

/** 取出并清除；仅当 destConnectionId 匹配且未过期（15s） */
export function takePendingFilesTabDrop(destConnectionId: string): PendingFilesTabDrop | null {
  const cur = pendingTabDrop;
  if (!cur) return null;
  if (cur.destConnectionId !== destConnectionId) return null;
  if (Date.now() - cur.queuedAt > 15_000) {
    pendingTabDrop = null;
    return null;
  }
  pendingTabDrop = null;
  return cur;
}
