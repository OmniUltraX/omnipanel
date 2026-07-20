import { useCallback, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { TextInput } from "@/components/ui/form/TextInput";
import { useI18n } from "../../../i18n";
import { useAiStore } from "../../../stores/aiStore";

export interface AiConversationTitleProps {
  className?: string;
  id?: string;
  /** 用于 ai-panel-header 的 h3，SubWindow 标题区等 */
  as?: "h2" | "h3" | "div";
  /**
   * false：仅展示标题文本（外层已是下拉触发器，避免套一层 button）
   * true：点击进入重命名（默认）
   */
  interactive?: boolean;
}

export function AiConversationTitle({
  className,
  id,
  as: Tag = "div",
  interactive = true,
}: AiConversationTitleProps) {
  const { t } = useI18n();
  const conversations = useAiStore((s) => s.conversations);
  const activeConversationId = useAiStore((s) => s.activeConversationId);
  const renameConversation = useAiStore((s) => s.renameConversation);

  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const activeConv = conversations.find((c) => c.id === activeConversationId);
  const displayTitle = activeConv?.title || t("ai.conversations.newChatTitle");

  const startEditing = useCallback(() => {
    if (!activeConv) return;
    setEditValue(activeConv.title);
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }, [activeConv]);

  const commitRename = useCallback(() => {
    if (!activeConv || !editValue.trim()) {
      setEditing(false);
      return;
    }
    renameConversation(activeConv.id, editValue.trim());
    setEditing(false);
  }, [activeConv, editValue, renameConversation]);

  if (editing && interactive) {
    return (
      <Tag id={id} className={cn("ai-conversation-title", className)}>
        <TextInput
          ref={inputRef}
          clearable={false}
          copyable={false}
          value={editValue}
          onChange={setEditValue}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setEditing(false);
          }}
          className="ai-conversation-title-input"
          aria-label={t("ai.conversations.rename")}
        />
      </Tag>
    );
  }

  return (
    <Tag id={id} className={cn("ai-conversation-title", className)}>
      {interactive ? (
        <button
          type="button"
          onClick={startEditing}
          className="ai-conversation-title-button"
          title={t("ai.conversations.rename")}
          disabled={!activeConv}
        >
          <span className="truncate">{displayTitle}</span>
        </button>
      ) : (
        <span className="ai-conversation-title-text truncate" title={displayTitle}>
          {displayTitle}
        </span>
      )}
    </Tag>
  );
}
