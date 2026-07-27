import { useEffect, useMemo } from "react";
import { EMPTY_TERMINAL_BLOCKS, useBlocksStore } from "../../stores/blocksStore";
import {
  dismissOrphanInlineToolCalls,
  hasLivePendingInlineTool,
} from "./inlineToolBridge";
import { findActiveInlineTerminalTool } from "./inlineTerminalTool";
import { ToolCallBar } from "./ToolCallBar";

type TerminalToolCallDockProps = {
  sessionId: string;
};

/** 底部 Command Bar 上方的 AI 命令确认条 */
export function TerminalToolCallDock({ sessionId }: TerminalToolCallDockProps) {
  const blocks = useBlocksStore((state) => state.blocks[sessionId] ?? EMPTY_TERMINAL_BLOCKS);
  const active = useMemo(
    () => findActiveInlineTerminalTool(blocks, sessionId),
    [blocks, sessionId],
  );

  // 僵尸确认条：UI 仍 pending，但内存 waiter 已丢失（恢复历史 / 热更新 / 中断）
  useEffect(() => {
    if (!active) return;
    if (active.item.status !== "pending" && active.item.status !== "running") return;
    if (hasLivePendingInlineTool(active.item.id)) return;
    const timer = window.setTimeout(() => {
      if (hasLivePendingInlineTool(active.item.id)) return;
      dismissOrphanInlineToolCalls(active.blockId);
    }, 600);
    return () => window.clearTimeout(timer);
  }, [active]);

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
