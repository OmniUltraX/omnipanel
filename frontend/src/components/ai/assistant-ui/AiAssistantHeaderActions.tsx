import { Button } from "../../ui/Button";
import { useI18n } from "../../../i18n";
import { useAiStore } from "../../../stores/aiStore";
function ConversationListIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M15 3v18" />
      <path d="M8 7h.01" />
      <path d="M8 12h.01" />
      <path d="M8 17h.01" />
    </svg>
  );
}

/** 标题栏左侧：会话列表折叠 */
export function AiAssistantHeaderLeft() {
  const { t } = useI18n();
  const conversationListOpen = useAiStore((s) => s.conversationListOpen);
  const toggleConversationList = useAiStore((s) => s.toggleConversationList);

  return (
    <div className="ai-panel-header-left">
      <Button
        variant="outline"
        size="sm"
        className={`h-7 gap-1.5 text-xs${conversationListOpen ? " is-active" : ""}`}
        title={t("ai.conversations.toggle")}
        aria-label={t("ai.conversations.toggle")}
        aria-pressed={conversationListOpen}
        onClick={toggleConversationList}
      >
        <ConversationListIcon />
        {t("ai.conversations.toggle")}
      </Button>
    </div>
  );
}

/** SubWindow 标题栏附加控件：会话列表折叠 */
export function AiAssistantHeaderToolbar() {
  return <AiAssistantHeaderLeft />;
}
