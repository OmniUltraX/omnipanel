import { useAiStore } from "../../../stores/aiStore";
import { useI18n } from "../../../i18n";
import {
  ASSISTANT_PAGE_AGENT_ID,
  getAgentDefinition,
  isAgentId,
} from "../../../lib/ai/agents";

/** 展示当前会话绑定的逻辑 Agent（前期布局可见性） */
export function AiAgentBadge() {
  const { t } = useI18n();
  const agentId = useAiStore((s) => {
    const conv = s.conversations.find((c) => c.id === s.activeConversationId);
    const id = conv?.agentId ?? ASSISTANT_PAGE_AGENT_ID;
    return isAgentId(id) ? id : ASSISTANT_PAGE_AGENT_ID;
  });
  const def = getAgentDefinition(agentId);
  const noTools = def.tools.kind === "none";

  return (
    <span
      className="ai-agent-badge"
      title={t(def.descriptionKey)}
      data-agent={agentId}
      data-no-tools={noTools ? "true" : "false"}
    >
      <span className="ai-agent-badge__label">{t(def.labelKey)}</span>
      {noTools ? (
        <span className="ai-agent-badge__hint">{t("ai.agents.noTools")}</span>
      ) : null}
    </span>
  );
}
