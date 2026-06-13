import type { ReactNode } from "react";
import type { OnPanelResize, PanelImperativeHandle, PanelProps } from "react-resizable-panels";
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
  rightPreset?: DockRailPreset;
  rightSizePx?: number;
  rightMinPx?: number;
  /** 像素；传字符串（如 `"100%"`）时原样交给 Panel */
  rightMaxPx?: number | string;
  bottomSizePx?: number;
  bottomMinPx?: number;
  bottomMaxPx?: number;
  /** 外部用于命令式控制底部面板（如 expand / collapse）的 ref */
  bottomPanelRef?: React.Ref<PanelImperativeHandle | null>;
  /** 底部面板尺寸变化回调（用于同步展开/收起状态） */
  onBottomPanelResize?: OnPanelResize;
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
  rightPreset = "default",
  rightSizePx,
  rightMinPx,
  rightMaxPx,
  bottomSizePx = 220,
  bottomMinPx = 160,
  bottomMaxPx = 420,
  bottomPanelRef,
  onBottomPanelResize,
  className,
}: DockWorkspaceProps) {
  const rail = RAIL_PRESETS[leftPreset];
  const leftDefault = leftSizePx ?? rail.defaultSize;
  const leftMin = leftMinPx ?? rail.minSize;
  const leftMax = leftMaxPx ?? rail.maxSize;

  const rightRail = RAIL_PRESETS[rightPreset];
  const rightDefault = rightSizePx ?? rightRail.defaultSize;
  const rightMin = rightMinPx ?? rightRail.minSize;
  const rightMax = rightMaxPx ?? rightRail.maxSize;

  const mainContent = bottom ? (
    <DockLayout direction="vertical">
      <DockPanel>
        {main}
      </DockPanel>
      <DockHandle direction="vertical" />
      <DockPanel
        defaultSize={bottomSizePx}
        minSize={bottomMinPx}
        maxSize={bottomMaxPx}
        collapsible
        collapsedSize={0}
        panelRef={bottomPanelRef}
        onResize={onBottomPanelResize}
        className="dock-panel-bottom"
      >
        {bottom}
      </DockPanel>
    </DockLayout>
  ) : (
    main
  );

  return (
    <div className={`dock-workspace${className ? ` ${className}` : ""}`}>
      <DockLayout>
        {left && (
          <>
            <DockPanel
              defaultSize={leftDefault}
              minSize={leftMin}
              maxSize={leftMax}
              collapsible
              collapsedSize={0}
              className="dock-panel-left"
            >
              <div className="dock-rail-shell">{left}</div>
            </DockPanel>
            <DockHandle />
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
