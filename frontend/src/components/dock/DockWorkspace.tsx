import { useCallback, type ReactNode } from "react";
import type { PanelImperativeHandle, PanelProps } from "react-resizable-panels";
import { DockLayout } from "./DockLayout";
import { DockPanel } from "./DockPanel";
import { DockHandle } from "./DockHandle";

export type DockRailPreset = "default" | "schema" | "host" | "server" | "settings" | "ai";

type RailSize = PanelProps["minSize"];

const RAIL_PRESETS: Record<DockRailPreset, { defaultSize: RailSize; minSize: RailSize; maxSize: RailSize }> = {
  default: { defaultSize: 260, minSize: 220, maxSize: 420 },
  schema: { defaultSize: 280, minSize: 280, maxSize: "100%" },
  host: { defaultSize: 280, minSize: 240, maxSize: 420 },
  server: { defaultSize: 220, minSize: 200, maxSize: 360 },
  settings: { defaultSize: 200, minSize: 180, maxSize: 280 },
  ai: { defaultSize: 240, minSize: 200, maxSize: 360 },
};

interface DockWorkspaceProps {
  left?: ReactNode;
  main: ReactNode;
  right?: ReactNode;
  bottom?: ReactNode;
  /** @deprecated 使用 leftPreset 或 leftSizePx */
  leftSize?: number;
  leftSizePx?: number;
  leftMinPx?: number;
  /** 像素；传字符串（如 `"100%"`）时原样交给 Panel */
  leftMaxPx?: number | string;
  leftPreset?: DockRailPreset;
  /** 左侧面板尺寸变化回调 */
  onLeftResize?: (sizePx: number) => void;
  /** 左侧面板拖拽结束或布局稳定后触发（用于持久化，避免拖拽过程中频繁写入） */
  onLeftLayoutChanged?: () => void;
  /** 左侧面板命令式 API（读取折叠后宽度等） */
  leftPanelRef?: React.Ref<PanelImperativeHandle | null>;
  /** 左侧分隔条附加 class（如终端侧栏顶栏对齐） */
  leftHandleClassName?: string;
  rightPreset?: DockRailPreset;
  rightSizePx?: number;
  rightMinPx?: number;
  /** 像素；传字符串（如 `"100%"`）时原样交给 Panel */
  rightMaxPx?: number | string;
  /** 右侧面板尺寸变化回调 */
  onRightResize?: (sizePx: number) => void;
  /** 右侧面板拖拽结束或布局稳定后触发 */
  onRightLayoutChanged?: () => void;
  bottomSizePx?: number;
  bottomMinPx?: number;
  bottomMaxPx?: number;
  /** 外部用于命令式控制底部面板（如 expand / collapse）的 ref */
  bottomPanelRef?: React.Ref<PanelImperativeHandle | null>;
  /** 底部面板实际像素高度变化 */
  onBottomPanelHeightChange?: (heightPx: number) => void;
  /** 底部面板拖拽中（指针移动） */
  onBottomLayoutChange?: () => void;
  /** 底部面板拖拽结束或布局稳定后触发 */
  onBottomResizeEnd?: () => void;
  /** task-bar 等固定高度模式：隐藏拖拽把手并锁定高度 */
  bottomHandleDisabled?: boolean;
  /** 用户按下底部分隔条时触发（用于取消程序化 snap 的短暂忽略窗口） */
  onBottomHandlePointerDown?: () => void;
  className?: string;
}

export function DockWorkspace({
  left,
  main,
  right,
  bottom,
  leftPreset = "default",
  leftSizePx,
  leftMinPx,
  leftMaxPx,
  onLeftResize,
  onLeftLayoutChanged,
  leftPanelRef,
  leftHandleClassName,
  rightPreset = "default",
  rightSizePx,
  rightMinPx,
  rightMaxPx,
  onRightResize,
  onRightLayoutChanged,
  bottomSizePx = 220,
  bottomMinPx = 0,
  bottomMaxPx = 420,
  bottomPanelRef,
  onBottomPanelHeightChange,
  onBottomLayoutChange,
  onBottomResizeEnd,
  bottomHandleDisabled = false,
  onBottomHandlePointerDown,
  className,
}: DockWorkspaceProps) {
  const handleBottomHeight = useCallback(
    (heightPx: number) => {
      onBottomPanelHeightChange?.(heightPx);
    },
    [onBottomPanelHeightChange],
  );
  const handleLeftResize = useCallback(
    (size: { inPixels: number }) => {
      onLeftResize?.(size.inPixels);
    },
    [onLeftResize],
  );
  const handleRightResize = useCallback(
    (size: { inPixels: number }) => {
      onRightResize?.(size.inPixels);
    },
    [onRightResize],
  );
  const rail = RAIL_PRESETS[leftPreset];
  const leftDefault = leftSizePx ?? rail.defaultSize;
  const leftMin = leftMinPx ?? rail.minSize;
  const leftMax = leftMaxPx ?? rail.maxSize;

  const rightRail = RAIL_PRESETS[rightPreset];
  const rightDefault = rightSizePx ?? rightRail.defaultSize;
  const rightMin = rightMinPx ?? rightRail.minSize;
  const rightMax = rightMaxPx ?? rightRail.maxSize;

  const handleHorizontalLayoutChanged = useCallback(() => {
    onLeftLayoutChanged?.();
    onRightLayoutChanged?.();
  }, [onLeftLayoutChanged, onRightLayoutChanged]);

  const mainContent = bottom ? (
    <DockLayout
      direction="vertical"
      onLayoutChange={onBottomLayoutChange}
      onLayoutChanged={onBottomResizeEnd}
    >
      <DockPanel>
        {main}
      </DockPanel>
      {!bottomHandleDisabled ? (
        <DockHandle
          direction="vertical"
          onPointerDown={onBottomHandlePointerDown}
        />
      ) : null}
      <DockPanel
        defaultSize={`${bottomSizePx}px`}
        minSize={`${bottomMinPx}px`}
        maxSize={`${bottomMaxPx}px`}
        collapsible
        collapsedSize={0}
        groupResizeBehavior="preserve-pixel-size"
        panelRef={bottomPanelRef}
        onResize={(panelSize) => {
          handleBottomHeight(panelSize.inPixels);
        }}
        className="dock-panel-bottom dock-panel-bottom--workspace"
      >
        {bottom}
      </DockPanel>
    </DockLayout>
  ) : (
    main
  );

  return (
    <div className={`dock-workspace${className ? ` ${className}` : ""}`}>
      <DockLayout onLayoutChanged={handleHorizontalLayoutChanged}>
        {left && (
          <>
            <DockPanel
              defaultSize={leftDefault}
              minSize={leftMin}
              maxSize={leftMax}
              collapsible
              collapsedSize={0}
              panelRef={leftPanelRef}
              onResize={onLeftResize ? handleLeftResize : undefined}
              className="dock-panel-left"
            >
              <div className="dock-rail-shell">{left}</div>
            </DockPanel>
            <DockHandle className={leftHandleClassName} />
          </>
        )}
        <DockPanel className="dock-panel-main">
          {mainContent}
        </DockPanel>
        {right && (
          <>
            <DockHandle />
            <DockPanel
              defaultSize={rightDefault}
              minSize={rightMin}
              maxSize={rightMax}
              collapsible
              collapsedSize={0}
              onResize={onRightResize ? handleRightResize : undefined}
              className="dock-panel-right"
            >
              <div className="dock-rail-shell">{right}</div>
            </DockPanel>
          </>
        )}
      </DockLayout>
    </div>
  );
}
