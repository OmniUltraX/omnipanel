import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useI18n } from "../../../i18n";
import { TextInput } from "../../../components/ui/form/TextInput";
import { registerScopedSearch } from "../../../components/ui/search/scopedSearchRegistry";
import type { SqlEditorHandle, SqlSearchMatchInfo } from "./SqlEditor";

export interface SqlEditorScopedSearchProps {
  editorRef: RefObject<SqlEditorHandle | null>;
  /** 只读时隐藏替换 */
  readOnly?: boolean;
  enabled?: boolean;
  className?: string;
  /** 文档变更时刷新匹配计数（如 SQL 文本） */
  docRevision?: string;
  children: ReactNode;
}

const EMPTY_MATCH: SqlSearchMatchInfo = { current: 0, total: 0 };

/**
 * SQL 编辑器区域搜索：ScopedSearch 外观 + 上一个/下一个/替换。
 * 高亮与跳转走 CodeMirror searchHighlight，不走 DOM 文本扫描。
 */
export function SqlEditorScopedSearch({
  editorRef,
  readOnly = false,
  enabled = true,
  className,
  docRevision,
  children,
}: SqlEditorScopedSearchProps) {
  const { t } = useI18n();
  const findInputId = useId();
  const replaceInputId = useId();
  const hostRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);

  const [visible, setVisible] = useState(false);
  const [query, setQuery] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [matchInfo, setMatchInfo] = useState<SqlSearchMatchInfo>(EMPTY_MATCH);

  const enabledRef = useRef(enabled);
  const visibleRef = useRef(visible);
  enabledRef.current = enabled;
  visibleRef.current = visible;

  const syncMatchInfo = useCallback(() => {
    const info = editorRef.current?.search.getMatchInfo() ?? EMPTY_MATCH;
    setMatchInfo(info);
    return info;
  }, [editorRef]);

  const applyQuery = useCallback(
    (nextQuery: string, options?: { scroll?: boolean }) => {
      setQuery(nextQuery);
      const info =
        editorRef.current?.search.setQuery(nextQuery, { scroll: options?.scroll }) ??
        EMPTY_MATCH;
      setMatchInfo(info);
      return info;
    },
    [editorRef],
  );

  const closeSearch = useCallback(() => {
    setQuery("");
    setReplaceText("");
    setReplaceOpen(false);
    setMatchInfo(EMPTY_MATCH);
    setVisible(false);
    editorRef.current?.search.clear();
  }, [editorRef]);

  const openSearch = useCallback(() => {
    setVisible(true);
    requestAnimationFrame(() => {
      const input = findInputRef.current;
      if (!input) return;
      input.focus({ preventScroll: true });
      input.select();
    });
  }, []);

  useEffect(() => {
    return registerScopedSearch({
      getRoot: () => hostRef.current,
      isEnabled: () => enabledRef.current,
      isVisible: () => visibleRef.current,
      onActivate: openSearch,
      onEscape: closeSearch,
    });
  }, [openSearch, closeSearch]);

  // 文档编辑后刷新匹配数（装饰由 CM 字段自动更新）
  useEffect(() => {
    if (!visible || !query.trim()) return;
    const info =
      editorRef.current?.search.setQuery(query, { scroll: false }) ?? EMPTY_MATCH;
    setMatchInfo(info);
  }, [docRevision, visible, query, editorRef]);

  // Ctrl/Cmd+H：展开替换（仅在宿主聚焦/可见搜索时）
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const isModH =
        (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "h";
      if (!isModH) return;
      const root = hostRef.current;
      if (!root) return;
      if (!root.contains(document.activeElement) && !root.matches(":hover") && !visibleRef.current) {
        return;
      }
      if (readOnly) return;
      e.preventDefault();
      e.stopPropagation();
      setVisible(true);
      setReplaceOpen(true);
      requestAnimationFrame(() => {
        replaceInputRef.current?.focus({ preventScroll: true });
      });
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [enabled, readOnly]);

  const onFindChange = useCallback(
    (value: string) => {
      applyQuery(value, { scroll: true });
    },
    [applyQuery],
  );

  const goNext = useCallback(() => {
    if (!query.trim()) return;
    setMatchInfo(editorRef.current?.search.findNext() ?? EMPTY_MATCH);
  }, [editorRef, query]);

  const goPrev = useCallback(() => {
    if (!query.trim()) return;
    setMatchInfo(editorRef.current?.search.findPrev() ?? EMPTY_MATCH);
  }, [editorRef, query]);

  const doReplace = useCallback(() => {
    if (readOnly || !query.trim()) return;
    setMatchInfo(editorRef.current?.search.replaceCurrent(replaceText) ?? EMPTY_MATCH);
  }, [editorRef, query, readOnly, replaceText]);

  const doReplaceAll = useCallback(() => {
    if (readOnly || !query.trim()) return;
    editorRef.current?.search.replaceAll(replaceText);
    syncMatchInfo();
  }, [editorRef, query, readOnly, replaceText, syncMatchInfo]);

  const onFindKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeSearch();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) goPrev();
      else goNext();
      return;
    }
    if (e.key === "F3") {
      e.preventDefault();
      if (e.shiftKey) goPrev();
      else goNext();
    }
  };

  const onReplaceKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeSearch();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      doReplace();
    }
  };

  const matchLabel =
    matchInfo.total > 0
      ? t("ui.scopedSearch.matchCount", {
          current: String(matchInfo.current),
          total: String(matchInfo.total),
        })
      : query.trim()
        ? t("ui.scopedSearch.noMatch")
        : "";

  return (
    <div
      ref={hostRef}
      className={`scoped-search-host sql-editor-scoped-search${className ? ` ${className}` : ""}`}
    >
      {visible ? (
        <div className="scoped-search-bar scoped-search-bar--editor" role="search">
          <div className="scoped-search-bar__row">
            <label className="scoped-search-bar__label" htmlFor={findInputId}>
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                width="12"
                height="12"
                aria-hidden
              >
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
            </label>
            <TextInput
              id={findInputId}
              ref={findInputRef}
              clearable={false}
              copyable={false}
              className="scoped-search-bar__input"
              value={query}
              onChange={onFindChange}
              onKeyDown={onFindKeyDown}
              placeholder={t("ui.scopedSearch.findPlaceholder")}
              spellCheck={false}
              autoComplete="off"
            />
            <span className="scoped-search-bar__count" aria-live="polite">
              {matchLabel}
            </span>
            <button
              type="button"
              className="scoped-search-bar__icon-btn"
              onClick={goPrev}
              disabled={matchInfo.total === 0}
              title={t("ui.scopedSearch.prev")}
              aria-label={t("ui.scopedSearch.prev")}
            >
              ↑
            </button>
            <button
              type="button"
              className="scoped-search-bar__icon-btn"
              onClick={goNext}
              disabled={matchInfo.total === 0}
              title={t("ui.scopedSearch.next")}
              aria-label={t("ui.scopedSearch.next")}
            >
              ↓
            </button>
            {!readOnly ? (
              <button
                type="button"
                className={`scoped-search-bar__icon-btn${replaceOpen ? " is-active" : ""}`}
                onClick={() => setReplaceOpen((v) => !v)}
                title={t("ui.scopedSearch.toggleReplace")}
                aria-label={t("ui.scopedSearch.toggleReplace")}
                aria-expanded={replaceOpen}
              >
                ↔
              </button>
            ) : null}
            <button
              type="button"
              className="scoped-search-bar__close"
              onClick={closeSearch}
              aria-label={t("ui.scopedSearch.close")}
              title={t("ui.scopedSearch.close")}
            >
              ×
            </button>
          </div>
          {!readOnly && replaceOpen ? (
            <div className="scoped-search-bar__row scoped-search-bar__row--replace">
              <label className="scoped-search-bar__label" htmlFor={replaceInputId}>
                <span className="scoped-search-bar__replace-glyph" aria-hidden>
                  ↔
                </span>
              </label>
              <TextInput
                id={replaceInputId}
                ref={replaceInputRef}
                clearable={false}
                copyable={false}
                className="scoped-search-bar__input"
                value={replaceText}
                onChange={setReplaceText}
                onKeyDown={onReplaceKeyDown}
                placeholder={t("ui.scopedSearch.replacePlaceholder")}
                spellCheck={false}
                autoComplete="off"
              />
              <button
                type="button"
                className="scoped-search-bar__text-btn"
                onClick={doReplace}
                disabled={matchInfo.total === 0}
              >
                {t("ui.scopedSearch.replace")}
              </button>
              <button
                type="button"
                className="scoped-search-bar__text-btn"
                onClick={doReplaceAll}
                disabled={matchInfo.total === 0}
              >
                {t("ui.scopedSearch.replaceAll")}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="scoped-search-content">{children}</div>
    </div>
  );
}
