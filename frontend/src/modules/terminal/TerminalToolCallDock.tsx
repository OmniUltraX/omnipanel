import { useMemo } from "react";
import { EMPTY_TERMINAL_BLOCKS, useBlocksStore } from "../../stores/blocksStore";
import { findActiveInlineTerminalTool } from "./inlineTerminalTool";
import { ToolCallBar } from "./ToolCallBar";

type TerminalToolCallDockProps = {
  sessionId: string;
};

/** 底部 Command Bar 上方的 AI 命令确认条 */
export function TerminalToolCallDock({ sessionId }: TerminalToolCallDockProps) {
  const blocks = useBlocksStore((state) => state.blocks[sessionId] ?? EMPTY_TERMINAL_BLOCKS);
  const active = useMemo(() => findActiveInlineTerminalTool(blocks), [blocks]);

  if (!active) return null;

  return (
    <ToolCallBar
      variant="dock"
      blockId={active.blockId}
      sessionId={sessionId}
      item={active.item}
    />
  );
}