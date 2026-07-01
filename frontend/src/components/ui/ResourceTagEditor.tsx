import { useState } from "react";
import { useI18n } from "../../i18n";
import {
  formatResourceTag,
  parseResourceTag,
  RESOURCE_TAG_KEYS,
  sortTagsForDisplay,
} from "../../lib/resourceTags";
import { ResourceTags } from "./ResourceTags";
import { TextInput } from "./TextInput";

const SYSTEM_KEYS = new Set<string>(Object.values(RESOURCE_TAG_KEYS));

function isSystemTag(tag: string): boolean {
  return SYSTEM_KEYS.has(parseResourceTag(tag).key);
}

type Props = {
  tags: string[];
  onChange: (tags: string[]) => void;
};

export function ResourceTagEditor({ tags, onChange }: Props) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");

  const systemTags = sortTagsForDisplay(tags.filter(isSystemTag));
  const customTags = sortTagsForDisplay(tags.filter((t) => !isSystemTag(t)));

  const addTag = () => {
    const raw = draft.trim();
    if (!raw) return;
    const normalized = raw.includes(":")
      ? raw
      : formatResourceTag("custom", raw);
    const { key, value } = parseResourceTag(normalized);
    if (!value.trim()) return;
    const formatted = formatResourceTag(key, value);
    if (tags.includes(formatted)) {
      setDraft("");
      return;
    }
    onChange([...tags, formatted]);
    setDraft("");
  };

  const removeTag = (tag: string) => {
    onChange(tags.filter((t) => t !== tag));
  };

  return (
    <div className="resource-tag-editor">
      {systemTags.length > 0 && (
        <div className="resource-tag-editor-section">
          <div className="resource-tag-editor-label">
            {t("resourceTags.system")}
            <span className="resource-tag-editor-hint">{t("resourceTags.systemHint")}</span>
          </div>
          <ResourceTags tags={systemTags} variant="compact" />
        </div>
      )}

      <div className="resource-tag-editor-section">
        <div className="resource-tag-editor-label">{t("resourceTags.custom")}</div>
        {customTags.length > 0 && (
          <div className="resource-tag-editor-chips">
            {customTags.map((tag) => {
              const { value } = parseResourceTag(tag);
              return (
                <span key={tag} className="resource-tag-editor-chip">
                  <span className="resource-tag-editor-chip-text" title={tag}>
                    {value}
                  </span>
                  <button
                    type="button"
                    className="resource-tag-editor-chip-remove"
                    onClick={() => removeTag(tag)}
                    aria-label={t("resourceTags.remove")}
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </div>
        )}
        <div className="resource-tag-editor-add">
          <TextInput
            className="input input-sm"
            size="sm"
            copyable={false}
            placeholder={t("resourceTags.addPlaceholder")}
            value={draft}
            onChange={setDraft}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTag();
              }
            }}
            style={{ flex: 1 }}
          />
          <button type="button" className="btn btn-secondary btn-sm" onClick={addTag}>
            {t("resourceTags.add")}
          </button>
        </div>
        <p className="form-hint">{t("resourceTags.addHint")}</p>
      </div>
    </div>
  );
}
