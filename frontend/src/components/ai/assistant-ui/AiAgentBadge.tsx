import { useMemo } from "react";

import { Select } from "../../ui/Select";
import { useAiStore } from "../../../stores/aiStore";
import { useI18n } from "../../../i18n";
import {
  ASSISTANT_PAGE_AGENT_ID,
  isAssistantPageAgentId,
  type AssistantPageAgentId,
} from "../../../lib/ai/agents";

const MODE_OPTIONS: {
  id: AssistantPageAgentId;
  labelKey: string;
  descKey: string;
}[] = [
  {
    id: "run",
    labelKey: "ai.agents.mode.run",
    descKey: "ai.agents.run.description",
  },
  {
    id: "plan",
    labelKey: "ai.agents.mode.plan",
    descKey: "ai.agents.plan.description",
  },
];

/** Composer 加号右侧：Cursor 风格 Agent / Plan 模式下拉 */
export function AiAgentBadge() {
  const { t } = useI18n();
  const activeConversationId = useAiStore((s) => s.activeConversationId);
  const isGenerating = useAiStore((s) => s.isGenerating);
  const createConversation = useAiStore((s) => s.createConversation);
  const agentId = useAiStore((s) => {
    const conv = s.conversations.find((c) => c.id === s.activeConversationId);
    const id = conv?.agentId ?? ASSISTANT_PAGE_AGENT_ID;
    return isAssistantPageAgentId(id) ? id : ASSISTANT_PAGE_AGENT_ID;
  });
  const setConversationAgentId = useAiStore((s) => s.setConversationAgentId);

  const options = useMemo(
    () =>
      MODE_OPTIONS.map((opt) => ({
        value: opt.id,
        label: t(opt.labelKey),
        title: t(opt.descKey),
        subtitle: t(opt.descKey),
      })),
    [t],
  );

  const handleChange = (next: string) => {
    if (!isAssistantPageAgentId(next)) return;
    if (activeConversationId) {
      if (next === agentId) return;
      setConversationAgentId(activeConversationId, next);
      return;
    }
    createConversation(undefined, undefined, { agentId: next });
  };

  return (
    <Select
      className="ai-agent-mode-select"
      value={agentId}
      onChange={handleChange}
      options={options}
      size="sm"
      borderless
      searchable={false}
      disabled={isGenerating}
      panelMinWidth={200}
      panelZIndex={1400}
      aria-label={t("ai.agents.mode.label")}
      title={t("ai.agents.mode.label")}
    />
  );
}
