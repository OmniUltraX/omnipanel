import { useEffect, useMemo, useState } from "react";

import { Select } from "../../ui/form/Select";
import { useI18n } from "../../../i18n";
import { commands, type SkillRecord } from "../../../ipc/bindings";
import { unwrapCommand } from "../../../ipc/result";
import { useActiveAgentAdapter } from "../../../lib/ai/agentAdapters";
import { useAiStore } from "../../../stores/aiStore";

const NONE_VALUE = "";

/** 输入区：当前会话（或无会话时的草稿）Skills 单选 */
export function AiConversationSkillSelect() {
  const { t } = useI18n();
  const agentAdapter = useActiveAgentAdapter();
  const activeConversationId = useAiStore((s) => s.activeConversationId);
  const activeConversation = useAiStore((s) =>
    s.conversations.find((c) => c.id === s.activeConversationId),
  );
  const isGenerating = useAiStore((s) => s.isGenerating);
  const draftSkillIds = useAiStore((s) => s.currentSkillIds);
  const setDraftSkillIds = useAiStore((s) => s.setCurrentSkillIds);
  const setConversationSkillIds = useAiStore((s) => s.setConversationSkillIds);

  const [skills, setSkills] = useState<SkillRecord[]>([]);

  useEffect(() => {
    if (agentAdapter) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await unwrapCommand(commands.skillList());
        if (cancelled) return;
        setSkills(list.filter((s) => s.enabled));
      } catch {
        if (!cancelled) setSkills([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentAdapter]);

  const options = useMemo(
    () => [
      {
        value: NONE_VALUE,
        label: t("ai.skillSelect.placeholder"),
      },
      ...skills.map((s) => ({
        value: s.id,
        label: s.name,
        subtitle: s.description || undefined,
        title: s.description || s.name,
      })),
    ],
    [skills, t],
  );

  const rawSkillIds = activeConversation?.selectedSkillIds ?? draftSkillIds;

  const selectedId = useMemo(() => {
    const allowed = new Set(skills.map((s) => s.id));
    return rawSkillIds.find((id) => allowed.has(id)) ?? NONE_VALUE;
  }, [rawSkillIds, skills]);

  // 历史多选 → 单选（只保留第一个有效 Skill）
  useEffect(() => {
    if (agentAdapter) return;
    if (rawSkillIds.length <= 1) return;
    const allowed = new Set(skills.map((s) => s.id));
    const first = rawSkillIds.find((id) => allowed.has(id));
    const next = first ? [first] : [];
    if (activeConversationId) {
      setConversationSkillIds(activeConversationId, next);
    } else {
      setDraftSkillIds(next);
    }
  }, [
    activeConversationId,
    agentAdapter,
    rawSkillIds,
    setConversationSkillIds,
    setDraftSkillIds,
    skills,
  ]);

  // 智能体适配模式：Skills 由智能体自管，隐藏本控件
  if (agentAdapter) return null;

  const handleChange = (next: string) => {
    const ids = next ? [next] : [];
    if (activeConversationId) {
      setConversationSkillIds(activeConversationId, ids);
      return;
    }
    setDraftSkillIds(ids);
  };

  if (skills.length === 0) {
    return (
      <span className="ai-model-select-empty" title={t("ai.skillSelect.empty")}>
        {t("ai.skillSelect.empty")}
      </span>
    );
  }

  return (
    <Select
      className="ai-model-select ai-skill-select is-borderless"
      value={selectedId}
      onChange={handleChange}
      options={options}
      size="sm"
      borderless
      searchable={skills.length > 6}
      searchPlaceholder={t("ai.skillSelect.search")}
      placeholder={t("ai.skillSelect.placeholder")}
      disabled={isGenerating}
      panelMinWidth={280}
      panelZIndex={1400}
      aria-label={t("ai.skillSelect.label")}
      title={t("ai.skillSelect.label")}
    />
  );
}
