import { memo } from "react";
import { AdvanceTerminal } from "./AdvanceTerminal";

interface TerminalTabDockPaneProps {
  tabId: string;
  isActive: boolean;
  onActivate?: () => void;
  /** 侧栏 dockview scope；镜像/SubWindow 须与模块主 dock 隔离 */
  sideDockScope?: string;
}

/** 终端模块 dock 与底部工作区镜像共用的完整面板（终端 + 可选右侧工具栏） */
export const TerminalTabDockPane = memo(function TerminalTabDockPane({
  tabId,
  isActive,
  onActivate,
  sideDockScope,
}: TerminalTabDockPaneProps) {
  return (
    <AdvanceTerminal
      tabId={tabId}
      isActive={isActive}
      onActivate={onActivate}
      sideDockScope={sideDockScope}
    />
  );
});
