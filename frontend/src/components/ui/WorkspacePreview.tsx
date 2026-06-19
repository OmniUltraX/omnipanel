import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useWorkspacePreviewCollapseStore } from "../../stores/workspacePreviewCollapseStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";

export interface WorkspacePreviewProps {
  children: ReactNode;
  className?: string;
}

/** 底部预览栏最大高度占窗口高度的比例 */
const MAX_HEIGHT_RATIO = 0.3;
/** 拖拽分隔条的固定高度（px） */
const HANDLE_HEIGHT_PX = 5;

function computeMaxPx(): number {
  return Math.floor(window.innerHeight * MAX_HEIGHT_RATIO);
}

/**
 * 工作区预览布局骨架（CSS Grid）。
 * 上方主内容区 + 拖拽分隔条 + 下方预览卡片区。
 * 底部预览栏显示真实工作区卡片，高亮当前工作区，点击可切换。
 */
export function WorkspacePreview({ children, className }: WorkspacePreviewProps) {
  const isOpen = useWorkspacePreviewCollapseStore((state) => state.isOpen);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const currentId = useWorkspaceStore((state) => state.workspace.id);
  const switchWorkspace = useWorkspaceStore((state) => state.switchWorkspace);
  const [maxPx, setMaxPx] = useState(computeMaxPx);
  const [heightPx, setHeightPx] = useState(computeMaxPx);
  const [isDragging, setIsDragging] = useState(false);

  const draggingRef = useRef(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);
  const maxPxRef = useRef(maxPx);
  const heightRef = useRef(heightPx);
  maxPxRef.current = maxPx;
  heightRef.current = heightPx;

  useEffect(() => {
    const onResize = () => {
      const m = computeMaxPx();
      setMaxPx(m);
      setHeightPx((h) => Math.min(h, m));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const clampHeight = useCallback((px: number) => {
    return Math.max(0, Math.min(px, maxPxRef.current));
  }, []);

  const onHandlePointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    draggingRef.current = true;
    setIsDragging(true);
    startYRef.current = e.clientY;
    startHeightRef.current = heightRef.current;
    document.body.classList.add("is-workspace-preview-resizing");
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!draggingRef.current) return;
      const dy = startYRef.current - e.clientY;
      setHeightPx(clampHeight(startHeightRef.current + dy));
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      setIsDragging(false);
      document.body.classList.remove("is-workspace-preview-resizing");
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [clampHeight]);

  const sidebarHeight = isOpen ? heightPx : 0;
  const handleHeight = isOpen ? HANDLE_HEIGHT_PX : 0;

  return (
    <div
      className={`workspace-preview${isOpen ? "" : " workspace-preview--collapsed"}${className ? ` ${className}` : ""}`}
      style={{ gridTemplateRows: `minmax(0, 1fr) ${handleHeight}px ${sidebarHeight}px` }}
    >
      <div className="workspace-preview__main">{children}</div>
      <div
        className="workspace-preview__handle"
        data-active={isDragging || undefined}
        hidden={!isOpen}
        role="separator"
        aria-orientation="horizontal"
        onPointerDown={onHandlePointerDown}
      />
      <div className="workspace-preview__sidebar" hidden={!isOpen}>
        <div className="workspace-preview__cards">
          {workspaces.map((ws) => (
            <button
              key={ws.id}
              type="button"
              className={`workspace-preview__card${ws.id === currentId ? " workspace-preview__card--active" : ""}`}
              onClick={() => switchWorkspace(ws.id)}
            >
              <div className="workspace-preview__card-thumb" />
              <div className="workspace-preview__card-meta">
                <div className="workspace-preview__card-title">{ws.name}</div>
                <div className="workspace-preview__card-subtitle">
                  {ws.description || ws.id}
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
