import { useEffect } from "react";

import {
  SKILL_PROMPT_WEEKLY_DISMISS_CAP,
  useSkillPromptStore,
} from "../../stores/skillPromptStore";
import { useAiStore } from "../../stores/aiStore";
import { useI18n } from "../../i18n";
import { submitAiPrompt } from "../../lib/ai/submitAiPrompt";
import { Button } from "../ui/primitives/Button";

/**
 * Skill 自我进化 — 主动提醒卡片（非模态）
 *
 * 触发：硬信号任一命中 或 软信号≥2 命中（见 skillPromptStore）
 * 位置：右下角浮层，避开顶部 toast
 * 行为：
 *   - 提取技能：打开 AI 助手 + 发送预填 prompt（不计入 dismiss）
 *   - 稍后提醒：dismiss +1（达到 cap 后本周不再提醒）
 *   - 本周不再提醒：直接设 dismissCount = cap
 */
export function SkillEvolutionPrompt() {
  const { t } = useI18n();
  const prompt = useSkillPromptStore((s) => s.currentPrompt);
  const dismissCount = useSkillPromptStore((s) => s.dismissCount);
  const dismiss = useSkillPromptStore((s) => s.dismiss);
  const dismissForWeek = useSkillPromptStore((s) => s.dismissForWeek);
  const acceptAndExtract = useSkillPromptStore((s) => s.acceptAndExtract);
  const resetWeekIfStale = useSkillPromptStore((s) => s.resetWeekIfStale);

  // 应用启动时检查 week 是否过期（跨周自动清零 dismissCount）
  useEffect(() => {
    resetWeekIfStale();
  }, [resetWeekIfStale]);

  if (!prompt) return null;

  const remaining = Math.max(0, SKILL_PROMPT_WEEKLY_DISMISS_CAP - dismissCount);

  const handleExtract = async () => {
    acceptAndExtract();
    useAiStore.getState().openDrawer();
    const promptText = t("skillPrompt.extractPromptText");
    try {
      await submitAiPrompt(promptText, { newConversation: true });
    } catch {
      // 失败也不阻塞——卡片已清掉，用户可手动重试
    }
  };

  const bodyKey = prompt.bodyKey;
  const body =
    bodyKey === "hard_recall"
      ? t("skillPrompt.bodyHardRecall")
      : bodyKey === "hard_extracted"
        ? t("skillPrompt.bodyHardExtracted")
        : bodyKey === "hard_refined"
          ? t("skillPrompt.bodyHardRefined")
          : t("skillPrompt.bodySoftBatch");

  return (
    <div
      className="skill-evolution-prompt"
      role="alert"
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="skill-evolution-prompt__header">
        <span className="skill-evolution-prompt__icon" aria-hidden="true">
          {/* 灯泡图标（SVG inline，避免依赖图标库） */}
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M8 1.5a4.5 4.5 0 0 0-2.5 8.23v1.27c0 .28.22.5.5.5h4a.5.5 0 0 0 .5-.5V9.73A4.5 4.5 0 0 0 8 1.5Zm1.5 11.5h-3a.5.5 0 0 0 0 1h3a.5.5 0 0 0 0-1Z"
              fill="currentColor"
            />
          </svg>
        </span>
        <h4 className="skill-evolution-prompt__title">{t("skillPrompt.title")}</h4>
        <button
          className="skill-evolution-prompt__close"
          onClick={dismiss}
          aria-label={t("skillPrompt.dismissLater")}
          title={t("skillPrompt.dismissLater")}
          type="button"
        >
          ×
        </button>
      </div>
      <p className="skill-evolution-prompt__body">{body}</p>
      <div className="skill-evolution-prompt__actions">
        <Button variant="primary" size="sm" onClick={() => void handleExtract()}>
          {t("skillPrompt.extractAction")}
        </Button>
        <Button variant="secondary" size="sm" onClick={dismiss}>
          {t("skillPrompt.dismissLater")}
        </Button>
        <Button variant="ghost" size="sm" onClick={dismissForWeek}>
          {t("skillPrompt.dismissWeek")}
        </Button>
      </div>
      {remaining > 0 ? (
        <p className="skill-evolution-prompt__hint">
          {t("skillPrompt.dismissRemaining", { count: remaining })}
        </p>
      ) : null}
    </div>
  );
}
