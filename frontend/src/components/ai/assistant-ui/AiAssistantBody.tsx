import { useAiStore } from "../../../stores/aiStore";
import { Thread } from "../../assistant-ui/thread";
import { ResizableSidePanel } from "../../ui/sidebar/ResizableSidePanel";
import { AiConversationList } from "./AiConversationList";

/** AI 助手主内容区：对话线程 + 可折叠会话列表 */
export function AiAssistantBody() {
  const conversationListOpen = useAiStore((s) => s.conversationListOpen);
  const conversationListWidth = useAiStore((s) => s.conversationListWidth);
  const setConversationListWidth = useAiStore((s) => s.setConversationListWidth);

  return (
    <div className="ai-assistant-shell-body">
      <div className="ai-dockview-content aui-dockview-content min-w-0 flex-1">
        <Thread />
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
