import { AiOrchestrationProgressPanel } from "./AiOrchestrationProgressPanel";

/**
 * AI 侧栏顶部：仅编排进度。
 * 审批内嵌条挂在输入框上方（见 Thread ViewportFooter / AiApprovalDock）。
 */
export function AiTaskAndDraftPanel() {
  return <AiOrchestrationProgressPanel />;
}
