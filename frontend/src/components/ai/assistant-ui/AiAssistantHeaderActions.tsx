import { McpConfigDialog } from "./McpConfigDialog";

/** 标题栏左侧：MCP 配置按钮 */
export function AiAssistantHeaderLeft() {
  return (
    <div className="ai-panel-header-left">
      <McpConfigDialog />
    </div>
  );
}

/** 标题栏右侧：会话列表 */
export function AiAssistantHeaderRight() {
  return null;
}

/** SubWindow 等场景：左右工具条合并为一行 */
export function AiAssistantHeaderToolbar() {
  return (
    <div className="ai-subwindow-header-toolbar">
      <AiAssistantHeaderLeft />
      <AiAssistantHeaderRight />
    </div>
  );
}
