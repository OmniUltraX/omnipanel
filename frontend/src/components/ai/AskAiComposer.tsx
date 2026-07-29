import { useCallback, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUpIcon } from "lucide-react";
import { useI18n } from "../../i18n";
import { Button } from "../ui/primitives/Button";
import { cn } from "../../lib/utils";

export interface AskAiComposerProps {
  placeholder?: string;
  submitLabel?: string;
  disabled?: boolean;
  className?: string;
  /** 受控值；不传则内部管理 */
  value?: string;
  onChange?: (value: string) => void;
  onSubmit: (prompt: string) => void | Promise<void>;
}

/**
 * 首页表面层输入框：视觉对齐 AI 侧栏 aui-composer-shell。
 * Enter 发送，Shift+Enter 换行。
 */
export function AskAiComposer({
  placeholder,
  submitLabel,
  disabled,
  className,
  value: controlled,
  onChange,
  onSubmit,
}: AskAiComposerProps) {
  const { t } = useI18n();
  const [inner, setInner] = useState("");
  const value = controlled ?? inner;
  const canSend = Boolean(value.trim()) && !disabled;

  const setValue = useCallback(
    (next: string) => {
      if (controlled === undefined) setInner(next);
      onChange?.(next);
    },
    [controlled, onChange],
  );

  const submit = useCallback(async () => {
    const text = value.trim();
    if (!text || disabled) return;
    await onSubmit(text);
    setValue("");
  }, [value, disabled, onSubmit, setValue]);

  const onFormSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  const shellVars = {
    ["--composer-radius"]: "4px",
    ["--composer-padding"]: "6px",
  } as CSSProperties;

  return (
    <form
      className={cn("ask-ai-composer", className)}
      onSubmit={onFormSubmit}
      data-slot="ask-ai-composer"
      style={shellVars}
    >
      <div
        data-slot="aui_composer-shell"
        className="ask-ai-composer__shell border-border focus-within:border-[var(--accent)] flex w-full flex-col gap-1 rounded-[var(--composer-radius)] border bg-bg p-[var(--composer-padding)] transition-[border-color] dark:border-muted-foreground/15 dark:focus-within:border-muted-foreground/30"
      >
        <textarea
          className="ask-ai-composer__input placeholder:text-muted-foreground/80 max-h-28 min-h-8 w-full resize-none bg-transparent px-1.5 py-0.5 text-[13px] leading-5 outline-none"
          rows={1}
          value={value}
          disabled={disabled}
          placeholder={placeholder ?? t("dashboard.inputPlaceholder")}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label={placeholder ?? t("dashboard.inputPlaceholder")}
        />
        <div className="ask-ai-composer__actions relative flex items-center justify-end">
          <Button
            type="submit"
            variant="default"
            size="icon"
            className="ask-ai-composer__send size-7 rounded-[var(--r-sm)]"
            disabled={!canSend}
            title={submitLabel ?? t("dashboard.send")}
            aria-label={submitLabel ?? t("dashboard.send")}
          >
            <ArrowUpIcon className="size-4.5" />
          </Button>
        </div>
      </div>
    </form>
  );
}
