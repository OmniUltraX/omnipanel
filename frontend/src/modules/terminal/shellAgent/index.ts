export {
  startOrContinueShellAgent,
  cancelShellAgent,
  newShellAgentSession,
  clearRemoteInputLine,
  clearRemoteInputLineBeforeExec,
  prepareShellAgentExecution,
  anchorShellAgentThinkingCard,
  notifyShellAgentStreaming,
  notifyShellAgentApprovalPending,
  notifyShellAgentExecuting,
  notifyShellAgentObserving,
  notifyShellAgentTurnFinished,
  notifyShellAgentIdle,
  onShellAgentCardFitStable,
} from "./loop";
export { useShellAgentStore } from "./shellAgentStore";
export {
  getShellAgentGeometry,
  subscribeShellAgentGeometry,
  clearShellAgentGeometry,
  cardRowsFor,
  minCardRowsFor,
  fitShellAgentCardToContent,
  resizeShellAgentCard,
} from "./shellAgentGeometry";
export { ShellAgentOverlay } from "./ShellAgentOverlay";
