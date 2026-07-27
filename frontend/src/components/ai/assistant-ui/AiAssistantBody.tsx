import { ArrowLeftIcon } from "lucide-react";
import { useAiStore } from "../../../stores/aiStore";
import { Thread } from "../../assistant-ui/thread";
import { ResizableSidePanel } from "../../ui/sidebar/ResizableSidePanel";
import { AiConversationList } from "./AiConversationList";
import { AiPanelToolbar } from "./AiAssistantHeaderActions";
import { useI18n } from "../../../i18n";

/** AI 助手主内容区：可选工具栏 + 对话线程；弹窗模式可带右侧历史栏 */
export function AiAssistantBody({
  showToolbar = false,
  showSideConversationList = false,
}: {
  /** Dock 模式：在窗口 chrome 下展示会话标题与聚合操作 */
  showToolbar?: boolean;
  /** 弹窗模式：右侧常驻历史会话栏（Dock 窄栏不展示） */
  showSideConversationList?: boolean;
}) {
  const { t } = useI18n();
  const conversationListWidth = useAiStore((s) => s.conversationListWidth);
  const setConversationListWidth = useAiStore((s) => s.setConversationListWidth);
  const viewingChildConversationId = useAiStore((s) => s.viewingChildConversationId);
  const viewingChildConv = useAiStore((s) =>
    s.conversations.find((c) => c.id === viewingChildConversationId),
  );
  const setViewingChildConversation = useAiStore((s) => s.setViewingChildConversation);

  return (
    <div className="ai-assistant-shell-body">
      <div className="ai-dockview-content aui-dockview-content min-w-0 flex-1 flex flex-col">
        {showToolbar ? <AiPanelToolbar showTitle /> : null}
        {/* 子会话视图模式：顶部显示"返回主会话"banner */}
        {viewingChildConv ? (
          <div className="ai-sub-conv-banner">
            <button
              type="button"
              className="ai-sub-conv-banner__back"
              onClick={() => setViewingChildConversation(null)}
            >
              <ArrowLeftIcon className="h-3.5 w-3.5" />
              <span>{t("ai.cluster.backToMain")}</span>
            </button>
            <span className="ai-sub-conv-banner__title truncate">
              {viewingChildConv.title}
            </span>
            <span className="ai-sub-conv-banner__hint">
              {t("ai.cluster.readOnly")}
            </span>
          </div>
        ) : null}
        <div className="min-h-0 flex-1">
          <Thread />
        </div>
      </div>
      {showSideConversationList ? (
        <ResizableSidePanel
          open
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
      ) : null}
    </div>
  );
}
