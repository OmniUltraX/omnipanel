import { useI18n } from "../../i18n";
import type { ReasoningEffortLevel } from "../../stores/aiStore";
import { useAiStore } from "../../stores/aiStore";

const LEVELS: ReasoningEffortLevel[] = ["default", "low", "medium", "high"];

const LABEL_KEYS: Record<ReasoningEffortLevel, "default" | "low" | "medium" | "high"> = {
  default: "default",
  low: "low",
  medium: "medium",
  high: "high",
};

function EffortIcon({ level }: { level: ReasoningEffortLevel }) {
  const bar = (h: number, active: boolean) => (
    <rect
      x={0}
      y={12 - h}
      width={3}
      height={h}
      rx={1}
      fill="currentColor"
      opacity={active ? 1 : 0.28}
    />
  );

  switch (level) {
    case "default":
      return (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
          <path
            d="M8 1.5l1.1 2.4 2.6.4-1.9 1.8.4 2.6L8 7.6 5.8 8.7l.4-2.6-1.9-1.8 2.6-.4L8 1.5z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          <circle cx="8" cy="8" r="1.1" fill="currentColor" opacity="0.85" />
        </svg>
      );
    case "low":
      return (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
          <g transform="translate(6.5, 2)">{bar(6, true)}</g>
        </svg>
      );
    case "medium":
      return (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
          <g transform="translate(4, 2)">
            {bar(6, true)}
            <g transform="translate(5, 0)">{bar(9, true)}</g>
          </g>
        </svg>
      );
    case "high":
      return (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
          <g transform="translate(2.5, 2)">
            {bar(5, true)}
            <g transform="translate(4.5, 0)">{bar(8, true)}</g>
            <g transform="translate(9, 0)">{bar(11, true)}</g>
          </g>
        </svg>
      );
  }
}

export interface AiReasoningEffortSelectProps {
  disabled?: boolean;
}

/** 推理程度选择（图标，置于输入框右上角） */
export function AiReasoningEffortSelect({ disabled = false }: AiReasoningEffortSelectProps) {
  const { t } = useI18n();
  const reasoningEffort = useAiStore((s) => s.reasoningEffort);
  const setReasoningEffort = useAiStore((s) => s.setReasoningEffort);

  return (
    <div
      className="ai-reasoning-effort"
      role="group"
      aria-label={t("ai.reasoningEffort.label")}
    >
      {LEVELS.map((level) => (
        <button
          key={level}
          type="button"
          className={`ai-reasoning-effort-btn${reasoningEffort === level ? " is-active" : ""}`}
          disabled={disabled}
          aria-pressed={reasoningEffort === level}
          title={`${t("ai.reasoningEffort.label")}: ${t(`ai.reasoningEffort.${LABEL_KEYS[level]}`)}`}
          onClick={() => setReasoningEffort(level)}
        >
          <EffortIcon level={level} />
        </button>
      ))}
    </div>
  );
}
