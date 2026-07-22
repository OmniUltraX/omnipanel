import { useMemo, useState, type KeyboardEvent } from "react";
import { useI18n } from "../../i18n";
import { normalizeKnowledgeTags } from "./knowledgeTags";

interface KnowledgeTagEditorProps {
  tags: string[];
  suggestions?: string[];
  onChange: (tags: string[]) => void;
}

export function KnowledgeTagEditor({ tags, suggestions = [], onChange }: KnowledgeTagEditorProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const cleanTags = useMemo(() => normalizeKnowledgeTags(tags), [tags]);
  const cleanSuggestions = useMemo(() => normalizeKnowledgeTags(suggestions), [suggestions]);

  const filteredSuggestions = useMemo(() => {
    const q = draft.trim().toLowerCase();
    if (!q) return [];
    return cleanSuggestions
      .filter((tag) => tag.toLowerCase().includes(q) && !cleanTags.includes(tag))
      .slice(0, 6);
  }, [draft, cleanSuggestions, cleanTags]);

  const commit = (value: string) => {
    const parsed = normalizeKnowledgeTags([value.replace(/^#/, "")]);
    if (parsed.length === 0) {
      setDraft("");
      return;
    }
    const next = [...cleanTags];
    for (const tag of parsed) {
      if (!next.some((item) => item.toLowerCase() === tag.toLowerCase())) {
        next.push(tag);
      }
    }
    onChange(next);
    setDraft("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commit(draft);
    } else if (event.key === "Backspace" && !draft && cleanTags.length > 0) {
      onChange(cleanTags.slice(0, -1));
    }
  };

  return (
    <div className="knowledge-tag-editor">
      {cleanTags.map((tag) => (
        <span key={tag} className="knowledge-tag-chip">
          #{tag}
          <button
            type="button"
            className="knowledge-tag-chip__remove"
            aria-label={t("knowledge.tagsUi.remove", { tag })}
            onClick={() => onChange(cleanTags.filter((item) => item !== tag))}
          >
            ×
          </button>
        </span>
      ))}
      <input
        className="knowledge-tag-editor__input"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => {
          if (draft.trim()) commit(draft);
        }}
        placeholder={
          cleanTags.length === 0 ? t("knowledge.tagsUi.placeholder") : t("knowledge.tagsUi.add")
        }
      />
      {filteredSuggestions.length > 0 ? (
        <div className="knowledge-tag-editor__suggestions">
          {filteredSuggestions.map((tag) => (
            <button
              key={tag}
              type="button"
              className="knowledge-tag-editor__suggestion"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => commit(tag)}
            >
              #{tag}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
