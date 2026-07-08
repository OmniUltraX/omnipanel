import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize, LogicalPosition } from "@tauri-apps/api/dpi";

type ResizeEdge = "top" | "bottom" | "left" | "right" | "top-left" | "top-right" | "bottom-left" | "bottom-right";

const EDGE_SIZE = 6;

export function WindowResize() {
  const [activeEdge, setActiveEdge] = useState<ResizeEdge | null>(null);
  const startPos = useRef({ x: 0, y: 0 });
  const startSize = useRef({ width: 0, height: 0 });
  const startWindowPos = useRef({ x: 0, y: 0 });

  const getEdge = (e: MouseEvent): ResizeEdge | null => {
    const { clientX, clientY } = e;
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
  };

  const getCursor = (edge: ResizeEdge | null): string => {
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
        return "default";
    }
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
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

        appWindow.setSize(new LogicalSize(newWidth, newHeight)).catch(() => undefined);
        if (activeEdge.includes("left") || activeEdge.includes("top")) {
          appWindow.setPosition(new LogicalPosition(newX, newY)).catch(() => undefined);
        }
      } else {
        const edge = getEdge(e);
        document.body.style.cursor = getCursor(edge);
      }
    };

    const handleMouseDown = async (e: MouseEvent) => {
      const edge = getEdge(e);
      if (edge) {
        setActiveEdge(edge);
        startPos.current = { x: e.clientX, y: e.clientY };
        const appWindow = getCurrentWindow();
        const size = await appWindow.innerSize();
        const position = await appWindow.outerPosition();
        startSize.current = { width: size.width, height: size.height };
        startWindowPos.current = { x: position.x, y: position.y };
        e.preventDefault();
      }
    };

    const handleMouseUp = () => {
      setActiveEdge(null);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [activeEdge]);

  return null;
}
