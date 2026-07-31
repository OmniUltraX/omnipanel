import { useMemo, useState } from "react";
import { HelpCircleIcon, CheckIcon, MinusIcon } from "lucide-react";
import type {
  AskUserAnswerValue,
  AskUserQuestion,
  UserQuestionFormData,
} from "../../lib/ai/aiMessageParts";
import {
  skipAskUserForm,
  submitAskUserAnswers,
} from "../../lib/ai/orchestration/askUserToolDispatcher";
import { validateAskUserAnswers } from "../../lib/ai/orchestration/askUserSchema";
import { useAiStore } from "../../stores/aiStore";
import { useI18n } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui/primitives/Button";
import { showToast } from "../../stores/toastStore";

type Props = {
  form: UserQuestionFormData;
};

function useLiveAskUserForm(snapshot: UserQuestionFormData): UserQuestionFormData {
  return useAiStore((s) => {
    for (const conv of s.conversations) {
      if (conv.id !== snapshot.conversationId) continue;
      for (const msg of conv.messages) {
        const part = msg.parts?.find(
          (p) => p.type === "user-question" && p.form.formId === snapshot.formId,
        );
        if (part && part.type === "user-question") return part.form;
      }
    }
    return snapshot;
  });
}

function optionLabel(q: AskUserQuestion, id: string): string {
  return q.options?.find((o) => o.id === id)?.label ?? id;
}

function AnswerSummary({ form }: { form: UserQuestionFormData }) {
  const { t } = useI18n();
  if (form.status === "skipped" || form.status === "superseded") {
    return (
      <p className="text-xs text-fg-2 px-2 pb-2">
        {form.status === "skipped"
          ? t("ai.askUser.skipped")
          : t("ai.askUser.superseded")}
      </p>
    );
  }
  const answers = form.answers ?? {};
  return (
    <ul className="flex flex-col gap-1 px-2 pb-2">
      {form.questions.map((q) => {
        const v = answers[q.id];
        let text = "—";
        if (Array.isArray(v)) {
          text = v.map((id) => optionLabel(q, id)).join("、") || "—";
        } else if (typeof v === "string" && v.trim()) {
          text = q.type === "text" ? v : optionLabel(q, v);
        }
        return (
          <li key={q.id} className="text-xs text-fg-2">
            <span className="text-fg">{q.prompt}</span>
            <span className="mx-1">·</span>
            <span>{text}</span>
          </li>
        );
      })}
    </ul>
  );
}

function QuestionField({
  question,
  value,
  onChange,
  disabled,
}: {
  question: AskUserQuestion;
  value: AskUserAnswerValue | undefined;
  onChange: (v: AskUserAnswerValue) => void;
  disabled: boolean;
}) {
  if (question.type === "text") {
    return (
      <input
        type="text"
        className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-fg outline-none focus:border-accent"
        value={typeof value === "string" ? value : ""}
        placeholder={question.placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  if (question.type === "multi_choice") {
    const selected = Array.isArray(value) ? value : [];
    return (
      <div className="flex flex-col gap-1">
        {(question.options ?? []).map((opt) => {
          const checked = selected.includes(opt.id);
          return (
            <label
              key={opt.id}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-xs transition-colors",
                checked
                  ? "border-accent/60 bg-accent/10 text-fg"
                  : "border-border bg-bg text-fg-2 hover:border-accent/40",
                disabled && "pointer-events-none opacity-60",
              )}
            >
              <input
                type="checkbox"
                className="accent-[var(--accent)]"
                checked={checked}
                disabled={disabled}
                onChange={() => {
                  if (checked) {
                    onChange(selected.filter((id) => id !== opt.id));
                  } else {
                    onChange([...selected, opt.id]);
                  }
                }}
              />
              <span>{opt.label}</span>
            </label>
          );
        })}
      </div>
    );
  }

  // single_choice
  const selected = typeof value === "string" ? value : "";
  return (
    <div className="flex flex-col gap-1">
      {(question.options ?? []).map((opt) => {
        const checked = selected === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            disabled={disabled}
            className={cn(
              "flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition-colors",
              checked
                ? "border-accent/60 bg-accent/10 text-fg"
                : "border-border bg-bg text-fg-2 hover:border-accent/40",
              disabled && "opacity-60",
            )}
            onClick={() => onChange(opt.id)}
          >
            <span
              className={cn(
                "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border",
                checked ? "border-accent bg-accent text-white" : "border-border",
              )}
            >
              {checked ? <CheckIcon className="h-2.5 w-2.5" /> : null}
            </span>
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function UserQuestionForm({ form: snapshot }: Props) {
  const { t } = useI18n();
  const form = useLiveAskUserForm(snapshot);
  const readonly = form.status !== "pending";
  const [answers, setAnswers] = useState<Record<string, AskUserAnswerValue>>(
    () => snapshot.answers ?? {},
  );
  const [busy, setBusy] = useState(false);

  const canSubmit = useMemo(
    () => validateAskUserAnswers(form.questions, answers) === null,
    [form.questions, answers],
  );

  const statusIcon =
    form.status === "answered" ? (
      <CheckIcon className="h-3.5 w-3.5 text-success" />
    ) : form.status === "skipped" || form.status === "superseded" ? (
      <MinusIcon className="h-3.5 w-3.5 text-fg-2" />
    ) : (
      <HelpCircleIcon className="h-3.5 w-3.5 text-accent" />
    );

  const statusLabel =
    form.status === "answered"
      ? t("ai.askUser.statusAnswered")
      : form.status === "skipped"
        ? t("ai.askUser.statusSkipped")
        : form.status === "superseded"
          ? t("ai.askUser.statusSuperseded")
          : t("ai.askUser.statusPending");

  const onSubmit = async () => {
    if (busy || readonly) return;
    const err = validateAskUserAnswers(form.questions, answers);
    if (err) {
      showToast(err);
      return;
    }
    setBusy(true);
    try {
      await submitAskUserAnswers(form.formId, answers);
    } catch (e) {
      showToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onSkip = async () => {
    if (busy || readonly) return;
    setBusy(true);
    try {
      await skipAskUserForm(form.formId);
    } catch (e) {
      showToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="my-2 overflow-hidden rounded-md border border-border bg-surface"
      data-slot="user-question-form"
      data-status={form.status}
      data-form-id={form.formId}
    >
      <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
        {statusIcon}
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg">
          {form.title?.trim() || t("ai.askUser.defaultTitle")}
        </span>
        <span className="shrink-0 text-[10px] text-fg-2">{statusLabel}</span>
      </div>

      {readonly ? (
        <AnswerSummary form={form} />
      ) : (
        <>
          <div className="flex flex-col gap-3 px-2 py-2">
            {form.questions.map((q) => (
              <div key={q.id} className="flex flex-col gap-1.5">
                <div className="text-xs text-fg">
                  {q.prompt}
                  {q.required !== false ? (
                    <span className="ml-0.5 text-destructive">*</span>
                  ) : null}
                </div>
                <QuestionField
                  question={q}
                  value={answers[q.id]}
                  disabled={busy}
                  onChange={(v) =>
                    setAnswers((prev) => ({
                      ...prev,
                      [q.id]: v,
                    }))
                  }
                />
              </div>
            ))}
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-border px-2 py-1.5">
            <Button
              type="button"
              variant="secondary"
              size="xs"
              disabled={busy}
              onClick={() => void onSkip()}
            >
              {t("ai.askUser.skip")}
            </Button>
            <Button
              type="button"
              variant="primary"
              size="xs"
              disabled={busy || !canSubmit}
              onClick={() => void onSubmit()}
            >
              {t("ai.askUser.submit")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
