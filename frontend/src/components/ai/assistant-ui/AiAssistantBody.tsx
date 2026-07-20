import { useAiStore } from "../../../stores/aiStore";
import { Thread } from "../../assistant-ui/thread";
import { ResizableSidePanel } from "../../ui/sidebar/ResizableSidePanel";
import { AiConversationList } from "./AiConversationList";
import { AiPanelToolbar } from "./AiAssistantHeaderActions";
import { AiContextStrip } from "../AiContextStrip";
import { AiTaskAndDraftPanel } from "../AiTaskAndDraftPanel";

/** AI 助手主内容区：可选工具栏 + 对话线程 + 可折叠会话列表 */
export function AiAssistantBody({
  showToolbar = false,
}: {
  /** Dock 模式：在窗口 chrome 下展示会话标题与聚合操作 */
  showToolbar?: boolean;
}) {
  const conversationListOpen = useAiStore((s) => s.conversationListOpen);
  const conversationListWidth = useAiStore((s) => s.conversationListWidth);
  const setConversationListWidth = useAiStore((s) => s.setConversationListWidth);

  return (
    <div className="ai-assistant-shell-body">
      <div className="ai-dockview-content aui-dockview-content min-w-0 flex-1 flex flex-col">
        {showToolbar ? <AiPanelToolbar showTitle /> : null}
        <AiContextStrip />
        <AiTaskAndDraftPanel />
        <div className="min-h-0 flex-1">
          <Thread />
        </div>
      </div>
      <ResizableSidePanel
        open={conversationListOpen}
        width={conversationListWidth}
        onWidthChange={setConversationListWidth}
        side="right"
        minWidth={180}
        maxWidth={420}
      >
        <aside className="ai-session-list ai-session-list--right h-full">
          <AiConversationList />
        </aside>
      </ResizableSidePanel>
    </div>
  );
}
