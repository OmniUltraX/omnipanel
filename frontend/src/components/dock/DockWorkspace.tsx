import type { ReactNode } from "react";
import type { PanelProps } from "react-resizable-panels";
import { DockLayout } from "./DockLayout";
import { DockPanel } from "./DockPanel";
import { DockHandle } from "./DockHandle";

export type DockRailPreset = "default" | "schema" | "host" | "server";

type RailSize = PanelProps["minSize"];

const RAIL_PRESETS: Record<DockRailPreset, { defaultSize: RailSize; minSize: RailSize; maxSize: RailSize }> = {
  default: { defaultSize: 260, minSize: 220, maxSize: 420 },
  schema: { defaultSize: 280, minSize: 280, maxSize: "100%" },
  host: { defaultSize: 280, minSize: 240, maxSize: 420 },
  server: { defaultSize: 220, minSize: 200, maxSize: 360 },
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
  rightSizePx?: number;
  rightMinPx?: number;
  rightMaxPx?: number;
  bottomSizePx?: number;
  bottomMinPx?: number;
  bottomMaxPx?: number;
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
  rightSizePx = 340,
  rightMinPx = 280,
  rightMaxPx = 520,
  bottomSizePx = 220,
  bottomMinPx = 160,
  bottomMaxPx = 420,
  className,
}: DockWorkspaceProps) {
  const rail = RAIL_PRESETS[leftPreset];
  const leftDefault = leftSizePx ?? rail.defaultSize;
  const leftMin = leftMinPx ?? rail.minSize;
  const leftMax = leftMaxPx ?? rail.maxSize;

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
              defaultSize={rightSizePx}
              minSize={rightMinPx}
              maxSize={rightMaxPx}
              collapsible
              collapsedSize={0}
              className="dock-panel-right"
            >
              {right}
            </DockPanel>
          </>
        )}
      </DockLayout>
    </div>
  );
}
