import { useAiStore } from "../../../stores/aiStore";
import { useI18n } from "../../../i18n";
import {
  ASSISTANT_PAGE_AGENT_ID,
  isAssistantPageAgentId,
  type AssistantPageAgentId,
} from "../../../lib/ai/agents";

const MODE_OPTIONS: { id: AssistantPageAgentId; labelKey: string }[] = [
  { id: "plan", labelKey: "ai.agents.mode.plan" },
  { id: "run", labelKey: "ai.agents.mode.run" },
];

/** 助手页 Plan / Run 模式切换（写入当前会话 agentId） */
export function AiAgentBadge() {
  const { t } = useI18n();
  const activeConversationId = useAiStore((s) => s.activeConversationId);
  const agentId = useAiStore((s) => {
    const conv = s.conversations.find((c) => c.id === s.activeConversationId);
    const id = conv?.agentId ?? ASSISTANT_PAGE_AGENT_ID;
    return isAssistantPageAgentId(id) ? id : ASSISTANT_PAGE_AGENT_ID;
  });
  const setConversationAgentId = useAiStore((s) => s.setConversationAgentId);

  const selectMode = (next: AssistantPageAgentId) => {
    if (!activeConversationId || next === agentId) return;
    setConversationAgentId(activeConversationId, next);
  };

  return (
    <div
      className="ai-agent-mode-switch"
      role="group"
      aria-label={t("ai.agents.mode.label")}
      data-agent={agentId}
    >
      {MODE_OPTIONS.map((opt) => {
        const active = opt.id === agentId;
        return (
          <button
            key={opt.id}
            type="button"
            className={`ai-agent-mode-switch__btn${active ? " is-active" : ""}`}
            aria-pressed={active}
            title={t(`ai.agents.${opt.id}.description`)}
            onClick={() => selectMode(opt.id)}
          >
            {t(opt.labelKey)}
          </button>
        );
      })}
    </div>
  );
}
