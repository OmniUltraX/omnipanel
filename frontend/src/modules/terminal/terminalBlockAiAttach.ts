import type { TerminalBlock } from "../../stores/blocksStore";
import { canAttachBlockToAiContext } from "./formatTerminalBlockForAiContext";
import { useTerminalAiInputContextStore } from "./terminalAiInputContextStore";

export function attachBlockToAiInput(
  sessionId: string,
  block: TerminalBlock,
  onFocusInput?: () => void,
): "ok" | "empty" | "duplicate" {
  if (!canAttachBlockToAiContext(block)) return "empty";
  const result = useTerminalAiInputContextStore.getState().attachBlock(sessionId, block.id);
  if (result === "duplicate") return "duplicate";
  onFocusInput?.();
  return "ok";
}
