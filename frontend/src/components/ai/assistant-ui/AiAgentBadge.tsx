import { useMemo } from "react";

import { Select } from "../../ui/Select";
import { useAiStore } from "../../../stores/aiStore";
import { useAgentSessionStore } from "../../../stores/agentSessionStore";
import { useI18n } from "../../../i18n";
import {
  ASSISTANT_PAGE_AGENT_ID,
  isAssistantPageAgentId,
  type AssistantPageAgentId,
} from "../../../lib/ai/agents";
import { useActiveAgentAdapter } from "../../../lib/ai/agentAdapters";
import { isSelectableOpenCodeAgent } from "../../../lib/ai/agentAdapters/types";
import { switchOpenCodeSessionAgent } from "../../../lib/ai/agentAdapters/sessionActions";

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

/** Composer 加号右侧：内置 Run/Plan；OpenCode 启用时改为 `/api/agent` 列表 */
export function AiAgentBadge() {
  const { t } = useI18n();
  const adapter = useActiveAgentAdapter();
  const activeConversationId = useAiStore((s) => s.activeConversationId);
  const isGenerating = useAiStore((s) => s.isGenerating);
  const createConversation = useAiStore((s) => s.createConversation);
  const setConversationAgentId = useAiStore((s) => s.setConversationAgentId);

  const builtinAgentId = useAiStore((s) => {
    const conv = s.conversations.find((c) => c.id === s.activeConversationId);
    const id = conv?.agentId ?? ASSISTANT_PAGE_AGENT_ID;
    return isAssistantPageAgentId(id) ? id : ASSISTANT_PAGE_AGENT_ID;
  });

  const openCodeAgents = useAgentSessionStore((s) => s.agents);
  const activeAgentName = useAgentSessionStore((s) => s.activeAgentName);
  const activeSessionId = useAgentSessionStore((s) => s.activeSessionId);
  const loadingAgents = useAgentSessionStore((s) => s.loadingAgents);

  const builtinOptions = useMemo(
    () =>
      MODE_OPTIONS.map((opt) => ({
        value: opt.id,
        label: t(opt.labelKey),
        title: t(opt.descKey),
        subtitle: t(opt.descKey),
      })),
    [t],
  );

  const openCodeOptions = useMemo(() => {
    return openCodeAgents.filter(isSelectableOpenCodeAgent).map((agent) => ({
      value: agent.name,
      label: agent.name,
      title: agent.description || agent.name,
      subtitle: agent.description || agent.mode,
    }));
  }, [openCodeAgents]);

  const handleBuiltinChange = (next: string) => {
    if (!isAssistantPageAgentId(next)) return;
    if (activeConversationId) {
      if (next === builtinAgentId) return;
      setConversationAgentId(activeConversationId, next);
      return;
    }
    createConversation(undefined, undefined, { agentId: next });
  };

  const handleOpenCodeChange = (next: string) => {
    if (!adapter || !next || next === activeAgentName) return;
    useAgentSessionStore.getState().setActiveAgentName(next);
    const sessionId = activeSessionId;
    if (sessionId) {
      void switchOpenCodeSessionAgent(adapter, sessionId, next).catch(() => {
        // 失败时仍保留本地选择，下次建会话会再试
      });
    }
  };

  if (adapter) {
    const value =
      activeAgentName && openCodeOptions.some((o) => o.value === activeAgentName)
        ? activeAgentName
        : (openCodeOptions[0]?.value ?? "");
    return (
      <Select
        className="ai-agent-mode-select"
        value={value}
        onChange={handleOpenCodeChange}
        options={openCodeOptions}
        size="sm"
        borderless
        searchable={false}
        disabled={isGenerating || loadingAgents || openCodeOptions.length === 0}
        panelMinWidth={220}
        panelZIndex={1400}
        aria-label={t("ai.agents.mode.label")}
        title={t("ai.agents.mode.label")}
      />
    );
  }

  return (
    <Select
      className="ai-agent-mode-select"
      value={builtinAgentId}
      onChange={handleBuiltinChange}
      options={builtinOptions}
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
