import {
  useCallback,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import {
  AI_DOCK_WIDTH_MIN,
  useSettingsStore,
} from "../../stores/settingsStore";

type AiDockviewResizeHandleProps = {
  /** 承载 `--ai-dock-w` 的 `.workspace` 节点 */
  workspaceRef: RefObject<HTMLDivElement | null>;
};

/**
 * 右侧 AI Dock 拖拽调宽。
 * 拖拽期间只改 DOM（CSS 变量 + dock 宽度），松手再写入 settings store，
 * 避免每帧重渲染 App / localStorage persist，同时保持宽度实时跟随。
 */
export function AiDockviewResizeHandle({
  workspaceRef,
}: AiDockviewResizeHandleProps) {
  const setAiDockWidth = useSettingsStore((s) => s.setAiDockWidth);
  const dragging = useRef(false);
  const widthRef = useRef(useSettingsStore.getState().aiDockWidth);
  const rafRef = useRef(0);

  const applyLiveWidth = useCallback(
    (width: number) => {
      const workspace = workspaceRef.current;
      if (!workspace) return;
      const css = `${width}px`;
      workspace.style.setProperty("--ai-dock-w", css);
      // 同步打到 dock 节点，避免祖先重渲染时 React style 把变量盖回旧值后视觉卡住
      const dock = workspace.querySelector<HTMLElement>(".ai-dockview");
      if (dock) {
        const maxWidth = Math.round(window.innerWidth * 0.5);
        dock.style.width = `${Math.min(width, maxWidth)}px`;
      }
    },
    [workspaceRef],
  );

  const clearDockInlineWidth = useCallback(() => {
    const dock =
      workspaceRef.current?.querySelector<HTMLElement>(".ai-dockview");
    if (dock) dock.style.width = "";
  }, [workspaceRef]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      dragging.current = true;
      widthRef.current = useSettingsStore.getState().aiDockWidth;
      workspaceRef.current?.classList.add("is-ai-dock-resizing");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMove = (moveEvent: PointerEvent) => {
        if (!dragging.current) return;
        const vw = window.innerWidth;
        const maxWidth = Math.round(vw * 0.5);
        const next = Math.max(
          AI_DOCK_WIDTH_MIN,
          Math.min(maxWidth, vw - moveEvent.clientX),
        );
        if (next === widthRef.current) return;
        widthRef.current = next;
        if (rafRef.current) return;
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = 0;
          applyLiveWidth(widthRef.current);
        });
      };

      const onUp = () => {
        if (!dragging.current) return;
        dragging.current = false;
        if (rafRef.current) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = 0;
        }
        applyLiveWidth(widthRef.current);
        clearDockInlineWidth();
        workspaceRef.current?.classList.remove("is-ai-dock-resizing");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        setAiDockWidth(widthRef.current);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [applyLiveWidth, clearDockInlineWidth, setAiDockWidth, workspaceRef],
  );

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      workspaceRef.current?.classList.remove("is-ai-dock-resizing");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    },
    [workspaceRef],
  );

  return (
    <div
      className="ai-dockview-resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整 AI 助手宽度"
      onPointerDown={onPointerDown}
    />
  );
}
