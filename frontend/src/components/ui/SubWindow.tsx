import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../i18n";
import { Button } from "./Button";
import { SubWindowControls } from "./SubWindowControls";
import {
  registerMinimizedSubWindow,
  unregisterMinimizedSubWindow,
} from "../../lib/subWindowMinimizedRegistry";
import {
  dispatchDebouncedWindowResize,
  dispatchSubWindowResize,
} from "../../lib/subWindowResize";
import {
  clampSubWindowGeometry,
  createCenteredSubWindowGeometry,
  maximizedSubWindowGeometry,
  resizeSubWindowGeometry,
  type SubWindowGeometry,
  type SubWindowResizeDirection,
} from "../../lib/subWindowGeometry";

export interface SubWindowProps {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** 相对主窗口可视区域的宽度比例，默认 0.9 */
  widthRatio?: number;
  /** 相对主窗口可视区域的高度比例，默认 0.9 */
  heightRatio?: number;
  className?: string;
  /** 标题与关闭按钮之间的附加控件（如模型选择） */
  headerExtra?: ReactNode;
  /** 是否启用拖动、缩放与最大化/最小化，默认 true */
  windowChrome?: boolean;
  /** 是否隐藏遮罩层，默认 false */
  noOverlay?: boolean;
  /** 自定义最小化行为，不传则使用内置最小化（右侧浮动条） */
  onMinimize?: () => void;
}

type SubWindowVisualState = "normal" | "maximized" | "minimized";

const DEFAULT_RATIO = 0.9;
const RESIZE_HANDLES: SubWindowResizeDirection[] = [
  "n",
  "s",
  "e",
  "w",
  "ne",
  "nw",
  "se",
  "sw",
];

function isInteractiveHeaderTarget(target: EventTarget | null): boolean {
  return Boolean(
    (target as HTMLElement | null)?.closest(
      "button, .win-controls, .subwindow-header-extra, a, input, select, textarea, label",
    ),
  );
}

export function SubWindow({
  open,
  title,
  onClose,
  children,
  widthRatio = DEFAULT_RATIO,
  heightRatio = DEFAULT_RATIO,
  className,
  headerExtra,
  windowChrome = true,
  noOverlay = false,
  onMinimize,
}: SubWindowProps) {
  const { t } = useI18n();
  const subWindowId = useId();
  const [visualState, setVisualState] = useState<SubWindowVisualState>("normal");
  const [geometry, setGeometry] = useState<SubWindowGeometry>(() =>
    createCenteredSubWindowGeometry(widthRatio, heightRatio),
  );
  const restoreGeometryRef = useRef<SubWindowGeometry | null>(null);
  const preMinimizeSnapshotRef = useRef<{
    visualState: Exclude<SubWindowVisualState, "minimized">;
    geometry: SubWindowGeometry;
  } | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origin: SubWindowGeometry;
  } | null>(null);
  const resizeRef = useRef<{
    pointerId: number;
    direction: SubWindowResizeDirection;
    startX: number;
    startY: number;
    origin: SubWindowGeometry;
  } | null>(null);

  const resetGeometry = useCallback(() => {
    const next = createCenteredSubWindowGeometry(widthRatio, heightRatio);
    setGeometry(next);
    restoreGeometryRef.current = null;
    preMinimizeSnapshotRef.current = null;
    setVisualState("normal");
  }, [heightRatio, widthRatio]);

  useLayoutEffect(() => {
    if (!open) return;
    resetGeometry();
  }, [open, resetGeometry]);

  useEffect(() => {
    if (!open || !windowChrome) return;
    const handleViewportResize = () => {
      if (visualState === "maximized") {
        setGeometry(maximizedSubWindowGeometry());
        return;
      }
      if (visualState === "normal") {
        setGeometry((current) => clampSubWindowGeometry(current));
      }
      dispatchDebouncedWindowResize();
    };
    window.addEventListener("resize", handleViewportResize);
    return () => window.removeEventListener("resize", handleViewportResize);
  }, [open, visualState, windowChrome]);

  useEffect(() => {
    if (!open || visualState === "minimized") return;
    const frame = requestAnimationFrame(() => {
      dispatchSubWindowResize(subWindowId);
    });
    return () => cancelAnimationFrame(frame);
  }, [geometry, open, visualState, subWindowId]);

  const handleRestoreFromMinimized = useCallback(() => {
    const snapshot = preMinimizeSnapshotRef.current;
    if (!snapshot) {
      setVisualState("normal");
      return;
    }
    if (snapshot.visualState === "maximized") {
      setGeometry(maximizedSubWindowGeometry());
      setVisualState("maximized");
      return;
    }
    setGeometry(clampSubWindowGeometry(snapshot.geometry));
    setVisualState("normal");
  }, []);

  const handleMinimize = useCallback(() => {
    if (onMinimize) {
      onMinimize();
      return;
    }
    if (visualState === "maximized") {
      preMinimizeSnapshotRef.current = {
        visualState: "maximized",
        geometry: maximizedSubWindowGeometry(),
      };
    } else {
      preMinimizeSnapshotRef.current = {
        visualState: "normal",
        geometry: { ...geometry },
      };
    }
    setVisualState("minimized");
  }, [geometry, onMinimize, visualState]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (visualState === "minimized") {
        handleRestoreFromMinimized();
        return;
      }
      onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [handleRestoreFromMinimized, onClose, open, visualState]);

  const minimizedTitle =
    typeof title === "string" ? title : t("shell.topbar.restore");

  useEffect(() => {
    if (!open || !windowChrome || visualState !== "minimized") {
      unregisterMinimizedSubWindow(subWindowId);
      return;
    }
    registerMinimizedSubWindow({
      id: subWindowId,
      title: minimizedTitle,
      onRestore: handleRestoreFromMinimized,
      onClose,
    });
    return () => unregisterMinimizedSubWindow(subWindowId);
  }, [
    handleRestoreFromMinimized,
    minimizedTitle,
    onClose,
    open,
    subWindowId,
    visualState,
    windowChrome,
  ]);

  useEffect(() => {
    if (open) return;
    unregisterMinimizedSubWindow(subWindowId);
  }, [open, subWindowId]);

  const handleToggleMaximize = useCallback(() => {
    if (visualState === "maximized") {
      setGeometry(
        restoreGeometryRef.current ?? createCenteredSubWindowGeometry(widthRatio, heightRatio),
      );
      restoreGeometryRef.current = null;
      setVisualState("normal");
      return;
    }
    restoreGeometryRef.current = geometry;
    setGeometry(maximizedSubWindowGeometry());
    setVisualState("maximized");
  }, [geometry, heightRatio, visualState, widthRatio]);

  const handleHeaderPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!windowChrome || visualState !== "normal") return;
      if (event.button !== 0 || isInteractiveHeaderTarget(event.target)) return;
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        origin: geometry,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    [geometry, visualState, windowChrome],
  );

  const handleHeaderPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    setGeometry(
      clampSubWindowGeometry({
        ...drag.origin,
        x: drag.origin.x + deltaX,
        y: drag.origin.y + deltaY,
      }),
    );
  }, []);

  const handleHeaderPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  const handleHeaderDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!windowChrome || isInteractiveHeaderTarget(event.target)) return;
      handleToggleMaximize();
    },
    [handleToggleMaximize, windowChrome],
  );

  const handleResizePointerDown = useCallback(
    (direction: SubWindowResizeDirection) => (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!windowChrome || visualState !== "normal") return;
      if (event.button !== 0) return;
      resizeRef.current = {
        pointerId: event.pointerId,
        direction,
        startX: event.clientX,
        startY: event.clientY,
        origin: geometry,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    },
    [geometry, visualState, windowChrome],
  );

  const handleResizePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - resize.startX;
    const deltaY = event.clientY - resize.startY;
    setGeometry(resizeSubWindowGeometry(resize.origin, resize.direction, deltaX, deltaY));
  }, []);

  const handleResizePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  if (!open) return null;

  const panelClass = [
    "subwindow-panel",
    className,
    windowChrome ? "subwindow-panel--windowed" : "",
    visualState === "maximized" ? "subwindow-panel--maximized" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const overlayClass = [
    "subwindow-overlay",
    windowChrome ? "" : "subwindow-overlay--centered",
    noOverlay ? "subwindow-overlay--no-backdrop" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const closeLabel = t("shell.topbar.close");
  const panelStyle = windowChrome
    ? {
        left: `${geometry.x}px`,
        top: `${geometry.y}px`,
        width: `${geometry.width}px`,
        height: `${geometry.height}px`,
      }
    : {
        width: `${Math.min(1, Math.max(0.1, widthRatio)) * 100}%`,
        height: `${Math.min(1, Math.max(0.1, heightRatio)) * 100}%`,
      };

  const titleNode =
    typeof title === "string" ? (
      <h2 id="subwindow-title" className="subwindow-title">
        {title}
      </h2>
    ) : (
      title
    );

  return createPortal(
    <>
      {visualState === "minimized" ? (
        <div className="subwindow-minimized-content-host" aria-hidden>
          {children}
        </div>
      ) : noOverlay ? (
        <div
          className={panelClass}
          role="dialog"
          aria-modal="false"
          aria-labelledby="subwindow-title"
          style={panelStyle}
        >
          <div
            className={`subwindow-header${windowChrome ? " subwindow-header--draggable" : ""}`}
            onPointerDown={handleHeaderPointerDown}
            onPointerMove={handleHeaderPointerMove}
            onPointerUp={handleHeaderPointerUp}
            onPointerCancel={handleHeaderPointerUp}
            onDoubleClick={handleHeaderDoubleClick}
          >
            {titleNode}
            {headerExtra ? (
              <div className="subwindow-header-extra">{headerExtra}</div>
            ) : null}
            {windowChrome ? (
              <SubWindowControls
                isMaximized={visualState === "maximized"}
                onMinimize={handleMinimize}
                onToggleMaximize={handleToggleMaximize}
                onClose={onClose}
              />
            ) : (
              <Button
                type="button"
                variant="icon"
                className="subwindow-close"
                title={closeLabel}
                aria-label={closeLabel}
                onClick={onClose}
              >
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  width="14"
                  height="14"
                  aria-hidden
                >
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </Button>
            )}
          </div>
          <div className="subwindow-body">{children}</div>
          {windowChrome && visualState === "normal"
            ? RESIZE_HANDLES.map((direction) => (
                <div
                  key={direction}
                  className={`subwindow-resize-handle subwindow-resize-handle--${direction}`}
                  onPointerDown={handleResizePointerDown(direction)}
                  onPointerMove={handleResizePointerMove}
                  onPointerUp={handleResizePointerUp}
                  onPointerCancel={handleResizePointerUp}
                />
              ))
            : null}
        </div>
      ) : (
        <div className={overlayClass} role="presentation" onClick={onClose}>
          <div
            className={panelClass}
            role="dialog"
            aria-modal="true"
            aria-labelledby="subwindow-title"
            style={panelStyle}
            onClick={(event) => event.stopPropagation()}
          >
            <div
              className={`subwindow-header${windowChrome ? " subwindow-header--draggable" : ""}`}
              onPointerDown={handleHeaderPointerDown}
              onPointerMove={handleHeaderPointerMove}
              onPointerUp={handleHeaderPointerUp}
              onPointerCancel={handleHeaderPointerUp}
              onDoubleClick={handleHeaderDoubleClick}
            >
              {titleNode}
              {headerExtra ? (
                <div className="subwindow-header-extra">{headerExtra}</div>
              ) : null}
              {windowChrome ? (
                <SubWindowControls
                  isMaximized={visualState === "maximized"}
                  onMinimize={handleMinimize}
                  onToggleMaximize={handleToggleMaximize}
                  onClose={onClose}
                />
              ) : (
                <Button
                  type="button"
                  variant="icon"
                  className="subwindow-close"
                  title={closeLabel}
                  aria-label={closeLabel}
                  onClick={onClose}
                >
                  <svg
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    width="14"
                    height="14"
                    aria-hidden
                  >
                    <path d="M4 4l8 8M12 4l-8 8" />
                  </svg>
                </Button>
              )}
            </div>
            <div className="subwindow-body">{children}</div>
            {windowChrome && visualState === "normal"
              ? RESIZE_HANDLES.map((direction) => (
                  <div
                    key={direction}
                    className={`subwindow-resize-handle subwindow-resize-handle--${direction}`}
                    onPointerDown={handleResizePointerDown(direction)}
                    onPointerMove={handleResizePointerMove}
                    onPointerUp={handleResizePointerUp}
                    onPointerCancel={handleResizePointerUp}
                  />
                ))
              : null}
          </div>
        </div>
      )}
    </>,
    document.body,
  );
}
