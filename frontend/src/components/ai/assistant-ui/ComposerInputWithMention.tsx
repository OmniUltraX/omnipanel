import {
  useCallback,
  useRef,
  useState,
  type FC,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { ComposerPrimitive, useComposerRuntime } from "@assistant-ui/react";

import { useI18n } from "../../../i18n";
import {
  ASSISTANT_PAGE_AGENT_ID,
  isAssistantPageAgentId,
} from "../../../lib/ai/agents";
import { useAiComposerContextStore } from "../../../stores/aiComposerContextStore";
import { useAiStore } from "../../../stores/aiStore";
import { ComposerContextMenu } from "./ComposerContextMenu";
import { parseAtMention, stripAtMention } from "./composerContextCatalog";

type MentionState = {
  start: number;
  query: string;
  caret: number;
};

/**
 * Composer 输入框：监听 `@` 弹出上下文菜单；选中后写入芯片并去掉 `@query`。
 */
export const ComposerInputWithMention: FC = () => {
  const { t } = useI18n();
  const composerRuntime = useComposerRuntime();
  const addItem = useAiComposerContextStore((s) => s.addItem);
  const assistantMode = useAiStore((s) => {
    const conv = s.conversations.find((c) => c.id === s.activeConversationId);
    const id = conv?.agentId ?? ASSISTANT_PAGE_AGENT_ID;
    return isAssistantPageAgentId(id) ? id : ASSISTANT_PAGE_AGENT_ID;
  });
  const placeholder =
    assistantMode === "run"
      ? t("ai.composer.placeholderRun")
      : t("ai.composer.placeholderPlan");
  const shellRef = useRef<HTMLDivElement>(null);
  const attachTriggerRef = useRef<HTMLButtonElement>(null);
  const [mention, setMention] = useState<MentionState | null>(null);

  const syncMentionFromDom = useCallback((el: HTMLTextAreaElement) => {
    const caret = el.selectionStart ?? el.value.length;
    const parsed = parseAtMention(el.value, caret);
    if (!parsed) {
      setMention(null);
      return;
    }
    setMention({ ...parsed, caret });
  }, []);

  const onInput = (event: FormEvent<HTMLTextAreaElement>) => {
    syncMentionFromDom(event.currentTarget);
  };

  const onSelect = (event: FormEvent<HTMLTextAreaElement>) => {
    syncMentionFromDom(event.currentTarget);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!mention) return;
    // 方向键 / 回车交给菜单的 capture 监听；此处阻止输入框默认行为
    if (
      event.key === "ArrowUp" ||
      event.key === "ArrowDown" ||
      event.key === "ArrowLeft" ||
      event.key === "ArrowRight" ||
      event.key === "Enter"
    ) {
      event.preventDefault();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setMention(null);
    }
  };

  const anchorRect = mention ? shellRef.current?.getBoundingClientRect() ?? null : null;

  return (
    <div ref={shellRef} className="composer-mention-input">
      <ComposerPrimitive.AddAttachment asChild>
        <button
          ref={attachTriggerRef}
          type="button"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
        />
      </ComposerPrimitive.AddAttachment>
      <ComposerPrimitive.Input
        placeholder={placeholder}
        className="aui-composer-input placeholder:text-muted-foreground/80 max-h-32 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-base outline-none"
        rows={1}
        autoFocus
        aria-label={placeholder}
        onInput={onInput}
        onSelect={onSelect}
        onKeyDown={onKeyDown}
      />
      <ComposerContextMenu
        open={mention != null}
        onOpenChange={(open) => {
          if (!open) setMention(null);
        }}
        anchorRect={anchorRect}
        filterQuery={mention?.query}
        onPickAttachment={() => {
          if (mention) {
            const text = composerRuntime.getState().text;
            composerRuntime.setText(stripAtMention(text, mention.start, mention.caret));
          }
          setMention(null);
          attachTriggerRef.current?.click();
        }}
        onPickItem={(item) => {
          addItem(item);
          if (mention) {
            const text = composerRuntime.getState().text;
            composerRuntime.setText(
              stripAtMention(text, mention.start, mention.caret).trimStart(),
            );
          }
          setMention(null);
        }}
      />
    </div>
  );
};
