import { AdvanceTerminal } from "./AdvanceTerminal";

interface TerminalTabDockPaneProps {
  tabId: string;
  isActive: boolean;
  onActivate?: () => void;
}

/** 终端模块 dock 与底部工作区镜像共用的完整面板（终端 + 可选右侧工具栏） */
export function TerminalTabDockPane({
  tabId,
  isActive,
  onActivate,
}: TerminalTabDockPaneProps) {
  return (
    <AdvanceTerminal
      tabId={tabId}
      isActive={isActive}
      onActivate={onActivate}
    />
  );
}
