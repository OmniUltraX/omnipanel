import { useEffect, useMemo } from "react";

import { Select } from "../../ui/Select";
import { useAgentSessionStore } from "../../../stores/agentSessionStore";
import { useAiStore } from "../../../stores/aiStore";
import { useI18n } from "../../../i18n";
import { useActiveAgentAdapter } from "../../../lib/ai/agentAdapters";
import { isSelectableOpenCodeAgent } from "../../../lib/ai/agentAdapters/types";
import {
  refreshOpenCodeAgents,
  switchOpenCodeSessionAgent,
} from "../../../lib/ai/agentAdapters/sessionActions";

/** Composer 加号右侧：仅 OpenCode 启用时展示 `/api/agent` 列表；Cursor / 内置编排不显示。 */
export function AiAgentBadge() {
  const { t } = useI18n();
  const adapter = useActiveAgentAdapter();
  const isGenerating = useAiStore((s) => s.isGenerating);

  const openCodeAgents = useAgentSessionStore((s) => s.agents);
  const activeAgentName = useAgentSessionStore((s) => s.activeAgentName);
  const activeSessionId = useAgentSessionStore((s) => s.activeSessionId);
  const loadingAgents = useAgentSessionStore((s) => s.loadingAgents);

  // 列表为空时主动补拉（避免仅依赖 AiRuntimeProvider 启动 effect，失败后一直空白）
  useEffect(() => {
    if (!adapter) return;
    if (loadingAgents || openCodeAgents.length > 0) return;
    void refreshOpenCodeAgents(adapter);
  }, [adapter, loadingAgents, openCodeAgents.length]);

  const openCodeOptions = useMemo(() => {
    const selectable = openCodeAgents.filter(isSelectableOpenCodeAgent);
    // primary/all 过滤为空时，回退到全部非 hidden，避免下拉「没数据」
    const source =
      selectable.length > 0 ? selectable : openCodeAgents.filter((a) => !a.hidden);
    return source.map((agent) => ({
      // OpenCode 执行期按 id 查找；name 仅作展示（Build ≠ build）
      value: agent.id,
      label: agent.name || agent.id,
      title: agent.description || agent.name || agent.id,
      subtitle: agent.description || agent.mode,
    }));
  }, [openCodeAgents]);

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

  if (!adapter) {
    return null;
  }

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
      placeholder={loadingAgents ? "…" : t("ai.agents.mode.label")}
      emptyText={t("ai.agents.mode.label")}
      panelMinWidth={220}
      panelZIndex={1400}
      aria-label={t("ai.agents.mode.label")}
      title={t("ai.agents.mode.label")}
    />
  );
}
