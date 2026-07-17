import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize, LogicalPosition } from "@tauri-apps/api/dpi";

type ResizeEdge =
  | "top"
  | "bottom"
  | "left"
  | "right"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

const EDGE_SIZE = 6;

/** 标题栏 / 窗口控件区域：禁止当成缩放边，否则会抢走拖拽与按钮点击 */
const CHROME_BLOCK_SELECTOR = [
  ".win-controls",
  ".win-btn",
  ".dock-window-title-actions",
  ".dv-tabs-and-actions-container",
  ".dv-right-actions-container",
  ".workspace-panel-empty-topbar",
  ".workspace-bottom-titlebar",
  ".topbar",
  ".sidebar",
].join(",");

function isChromeTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(CHROME_BLOCK_SELECTOR));
}

function getEdge(clientX: number, clientY: number): ResizeEdge | null {
  const { innerWidth, innerHeight } = window;

  const isTop = clientY < EDGE_SIZE;
  const isBottom = clientY > innerHeight - EDGE_SIZE;
  const isLeft = clientX < EDGE_SIZE;
  const isRight = clientX > innerWidth - EDGE_SIZE;

  if (isTop && isLeft) return "top-left";
  if (isTop && isRight) return "top-right";
  if (isBottom && isLeft) return "bottom-left";
  if (isBottom && isRight) return "bottom-right";
  if (isTop) return "top";
  if (isBottom) return "bottom";
  if (isLeft) return "left";
  if (isRight) return "right";

  return null;
}

function getCursor(edge: ResizeEdge | null): string {
  switch (edge) {
    case "top":
    case "bottom":
      return "ns-resize";
    case "left":
    case "right":
      return "ew-resize";
    case "top-left":
    case "bottom-right":
      return "nwse-resize";
    case "top-right":
    case "bottom-left":
      return "nesw-resize";
    default:
      return "";
  }
}

/**
 * 无边框窗口边缘缩放。
 *
 * 注意：缩放状态必须用 ref，禁止把 activeEdge 放进 useEffect 依赖——
 * 否则 mousedown 里 setState 会卸载/重挂 mouseup，松手事件丢失后
 * 窗口会卡在持续 setSize，表现为全界面卡顿、标题栏拖拽与按钮全部失效。
 */
export function WindowResize() {
  const activeEdgeRef = useRef<ResizeEdge | null>(null);
  const startPos = useRef({ x: 0, y: 0 });
  const startSize = useRef({ width: 0, height: 0 });
  const startWindowPos = useRef({ x: 0, y: 0 });
  const pendingStartRef = useRef(false);

  useEffect(() => {
    const clearActive = () => {
      activeEdgeRef.current = null;
      pendingStartRef.current = false;
      if (document.body.style.cursor) {
        document.body.style.cursor = "";
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      const activeEdge = activeEdgeRef.current;
      if (activeEdge) {
        const dx = e.clientX - startPos.current.x;
        const dy = e.clientY - startPos.current.y;
        const appWindow = getCurrentWindow();

        let newWidth = startSize.current.width;
        let newHeight = startSize.current.height;
        let newX = startWindowPos.current.x;
        let newY = startWindowPos.current.y;

        if (activeEdge.includes("right")) {
          newWidth = Math.max(800, startSize.current.width + dx);
        }
        if (activeEdge.includes("left")) {
          const widthChange = Math.min(dx, startSize.current.width - 800);
          newWidth = startSize.current.width - widthChange;
          newX = startWindowPos.current.x + widthChange;
        }
        if (activeEdge.includes("bottom")) {
          newHeight = Math.max(600, startSize.current.height + dy);
        }
        if (activeEdge.includes("top")) {
          const heightChange = Math.min(dy, startSize.current.height - 600);
          newHeight = startSize.current.height - heightChange;
          newY = startWindowPos.current.y + heightChange;
        }

        void appWindow.setSize(new LogicalSize(newWidth, newHeight)).catch(() => undefined);
        if (activeEdge.includes("left") || activeEdge.includes("top")) {
          void appWindow
            .setPosition(new LogicalPosition(newX, newY))
            .catch(() => undefined);
        }
        return;
      }

      if (isChromeTarget(e.target)) {
        if (document.body.style.cursor) document.body.style.cursor = "";
        return;
      }

      const edge = getEdge(e.clientX, e.clientY);
      const cursor = getCursor(edge);
      document.body.style.cursor = cursor;
    };

    const handleMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (isChromeTarget(e.target)) return;

      const edge = getEdge(e.clientX, e.clientY);
      if (!edge) return;

      // 先同步占住边，避免 await 期间 mouseup 丢失后无法清理
      pendingStartRef.current = true;
      activeEdgeRef.current = edge;
      startPos.current = { x: e.clientX, y: e.clientY };
      e.preventDefault();

      const appWindow = getCurrentWindow();
      void (async () => {
        try {
          const [size, position] = await Promise.all([
            appWindow.innerSize(),
            appWindow.outerPosition(),
          ]);
          if (!pendingStartRef.current || activeEdgeRef.current !== edge) return;
          startSize.current = { width: size.width, height: size.height };
          startWindowPos.current = { x: position.x, y: position.y };
        } catch {
          clearActive();
        }
      })();
    };

    const handleMouseUp = () => {
      clearActive();
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("mouseup", handleMouseUp);
    window.addEventListener("blur", clearActive);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("blur", clearActive);
      clearActive();
    };
  }, []);

  return null;
}
