import { AiAssistantBody } from "./AiAssistantBody";

export interface AiAssistantShellProps {
  /**
   * Dock 模式：展示会话工具栏（标题/操作）。
   * 窗口 chrome（拖拽条/三键）由主窗口 tab 栏贯通承载，不再单独占一层。
   */
  showDockHeader?: boolean;
}

export function AiAssistantShell({ showDockHeader }: AiAssistantShellProps) {
  return (
    <div className="ai-assistant-shell aui-shell">
      <AiAssistantBody showToolbar={Boolean(showDockHeader)} />
    </div>
  );
}
