import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useWorkspacePreviewCollapseStore } from "../../stores/workspacePreviewCollapseStore";

export interface WorkspacePreviewProps {
  children: ReactNode;
  className?: string;
}

/** 底部预览栏最大高度占窗口高度的比例 */
const MAX_HEIGHT_RATIO = 0.3;
/** 拖拽分隔条的固定高度（px） */
const HANDLE_HEIGHT_PX = 5;
/** 测试用卡片数量 */
const TEST_CARD_COUNT = 6;

function computeMaxPx(): number {
  return Math.floor(window.innerHeight * MAX_HEIGHT_RATIO);
}

const TEST_CARDS = Array.from({ length: TEST_CARD_COUNT }, (_, i) => ({
  id: i + 1,
  title: `工作区 ${i + 1}`,
  subtitle: `dev / project-${i + 1}`,
}));

/**
 * 工作区预览布局骨架（CSS Grid）。
 * 上方主内容区 + 拖拽分隔条 + 下方预览卡片区。
 * 底部预览栏高度可在 0 ~ 30% 窗口高度之间拖拽调整；收起/展开由 store 驱动。
 */
export function WorkspacePreview({ children, className }: WorkspacePreviewProps) {
  const isOpen = useWorkspacePreviewCollapseStore((state) => state.isOpen);
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
          {TEST_CARDS.map((card) => (
            <div key={card.id} className="workspace-preview__card">
              <div className="workspace-preview__card-thumb" />
              <div className="workspace-preview__card-meta">
                <div className="workspace-preview__card-title">{card.title}</div>
                <div className="workspace-preview__card-subtitle">{card.subtitle}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
