import { useEffect, useMemo, useState } from "react";

import { MultiSelect } from "../../ui/form/MultiSelect";
import { useI18n } from "../../../i18n";
import { commands, type SkillRecord } from "../../../ipc/bindings";
import { unwrapCommand } from "../../../ipc/result";
import { useAiStore } from "../../../stores/aiStore";

/** 输入区：当前会话（或无会话时的草稿）Skills 多选 */
export function AiConversationSkillSelect() {
  const { t } = useI18n();
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
  }, []);

  const options = useMemo(
    () =>
      skills.map((s) => ({
        value: s.id,
        label: s.name,
        subtitle: s.description || undefined,
        title: s.description || s.name,
      })),
    [skills],
  );

  const selectedIds = useMemo(() => {
    const raw = activeConversation?.selectedSkillIds ?? draftSkillIds;
    const allowed = new Set(options.map((o) => o.value));
    return raw.filter((id) => allowed.has(id));
  }, [activeConversation?.selectedSkillIds, draftSkillIds, options]);

  const handleChange = (next: string[]) => {
    if (activeConversationId) {
      setConversationSkillIds(activeConversationId, next);
      return;
    }
    setDraftSkillIds(next);
  };

  if (options.length === 0) {
    return (
      <span className="ai-model-select-empty" title={t("ai.skillSelect.empty")}>
        {t("ai.skillSelect.empty")}
      </span>
    );
  }

  return (
    <MultiSelect
      className="ai-model-select ai-skill-select is-borderless"
      values={selectedIds}
      onChange={handleChange}
      options={options}
      size="sm"
      emptyMeansAll={false}
      searchable={options.length > 6}
      searchPlaceholder={t("ai.skillSelect.search")}
      placeholder={t("ai.skillSelect.placeholder")}
      disabled={isGenerating}
      panelMinWidth={280}
      panelZIndex={1400}
      aria-label={t("ai.skillSelect.label")}
      title={t("ai.skillSelect.label")}
      formatDisplayLabel={(labels, allSelected) => {
        if (allSelected) return t("ai.skillSelect.all");
        if (labels.length === 0) return t("ai.skillSelect.placeholder");
        if (labels.length === 1) return labels[0]!;
        return t("ai.skillSelect.count", { count: labels.length });
      }}
    />
  );
}
