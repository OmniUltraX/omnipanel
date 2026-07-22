import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { useI18n } from "../../i18n";
import { commands } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { useTagStore } from "./tagStore";

interface GlobalTagEditorProps {
  kind: string;
  resourceId: string;
  tags?: string[];
  onChange?: (tags: string[]) => void;
  suggestions?: string[];
}

/**
 * 资源打标编辑器（始终全局词表）。
 * 与模块筛选弹窗不同：此处可选/新建任意标签路径，不限模块已用范围。
 * 传入 tags/onChange 时为受控模式（由父级保存）。
 */
export function GlobalTagEditor({
  kind,
  resourceId,
  tags: controlledTags,
  onChange,
  suggestions = [],
}: GlobalTagEditorProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  const globalTags = useTagStore((s) => s.tags);
  const refreshTree = useTagStore((s) => s.refresh);
  const tagsLoaded = useTagStore((s) => s.loaded);
  const isControlled = controlledTags != null && onChange != null;

  useEffect(() => {
    if (!tagsLoaded) void refreshTree();
  }, [tagsLoaded, refreshTree]);

  useEffect(() => {
    if (isControlled) {
      setPaths(controlledTags ?? []);
      return;
    }
    if (!resourceId) {
      setPaths([]);
      return;
    }
    let cancelled = false;
    void unwrapCommand(commands.resourceListTags(kind, resourceId))
      .then((list) => {
        if (!cancelled) {
          setPaths(list.filter((x) => x.source !== "system").map((x) => x.tag.path));
        }
      })
      .catch(() => {
        if (!cancelled) setPaths([]);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, resourceId, isControlled, controlledTags]);

  const cleanPaths = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of paths) {
      const key = p.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(p);
      }
    }
    return out;
  }, [paths]);

  const apply = async (next: string[]) => {
    setPaths(next);
    if (isControlled) {
      onChange?.(next);
      return;
    }
    if (!resourceId) return;
    await unwrapCommand(commands.resourceSetTags(kind, resourceId, next));
    void refreshTree();
  };

  /** 全局词表 + 调用方额外 suggestions，供补全；可自由输入未出现过的路径 */
  const allSuggestions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const tag of globalTags) {
      if (tag.kind === "system") continue;
      const key = tag.path.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(tag.path);
    }
    for (const s of suggestions) {
      const key = s.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
    return out;
  }, [globalTags, suggestions]);

  const filteredSuggestions = useMemo(() => {
    const q = draft.trim().toLowerCase();
    if (!q) return [];
    return allSuggestions
      .filter(
        (tag) =>
          tag.toLowerCase().includes(q) &&
          !cleanPaths.some((p) => p.toLowerCase() === tag.toLowerCase()),
      )
      .slice(0, 8);
  }, [draft, allSuggestions, cleanPaths]);

  const commit = (value: string) => {
    const path = value.trim().replace(/^#/, "");
    if (!path) {
      setDraft("");
      return;
    }
    if (cleanPaths.some((p) => p.toLowerCase() === path.toLowerCase())) {
      setDraft("");
      return;
    }
    void apply([...cleanPaths, path]);
    setDraft("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commit(draft);
    } else if (event.key === "Backspace" && !draft && cleanPaths.length > 0) {
      void apply(cleanPaths.slice(0, -1));
    }
  };

  return (
    <div className="knowledge-tag-editor global-tag-editor">
      {cleanPaths.map((tag) => (
        <span key={tag} className="knowledge-tag-chip">
          #{tag}
          <button
            type="button"
            className="knowledge-tag-chip__remove"
            aria-label={t("resourceTags.remove")}
            onClick={() => void apply(cleanPaths.filter((item) => item !== tag))}
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
          cleanPaths.length === 0 ? t("resourceTags.addPlaceholder") : t("resourceTags.add")
        }
      />
      {filteredSuggestions.length > 0 ? (
        <div className="knowledge-tag-editor__suggestions">
          {filteredSuggestions.map((tag) => (
            <button key={tag} type="button" onClick={() => commit(tag)}>
              #{tag}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
