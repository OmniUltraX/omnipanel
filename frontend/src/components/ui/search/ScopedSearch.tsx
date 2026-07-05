import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useI18n } from "../../../i18n";
import { TextInput } from "../form/TextInput";
import {
  applyScopedSearchHighlights,
  clearScopedSearchHighlights,
} from "./scopedSearchHighlight";
import { registerScopedSearch } from "./scopedSearchRegistry";
import {
  getTextSearchMatchIndices,
  splitTextByMatchIndices,
} from "../../../lib/textSearchMatch";

export interface ScopedSearchProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  /** �?false 时不响应 Ctrl/Cmd+F */
  enabled?: boolean;
  children: ReactNode;
}

export type ScopedSearchHandle = {
  /** 打开搜索框；传入 initialChar 时以该字符作为搜索词起始（光标定位到末尾），不传则沿用当前值并全选�?*/
  open: (initialChar?: string) => void;
  /** 关闭搜索框并清空搜索词�?*/
  close: () => void;
};

interface ScopedSearchContextValue {
  query: string;
}

const ScopedSearchContext = createContext<ScopedSearchContextValue | null>(null);

/** 当前 ScopedSearch 宿主内的搜索词（无上下文时为空字符串）�?*/
export function useScopedSearchQuery(): string {
  return useContext(ScopedSearchContext)?.query ?? "";
}

interface ScopedSearchTextProps {
  text: string;
  className?: string;
}

/**
 * �?React 树内按搜索词高亮文本（用于不便走 DOM 扫描的场景）�?
 * 宿主已启�?ScopedSearch 时，普通文本节点也会自动高亮，此组件为可选补充�?
 */
export function ScopedSearchText({ text, className }: ScopedSearchTextProps) {
  const query = useScopedSearchQuery().trim();
  if (!query) {
    return <span className={className}>{text}</span>;
  }

  const parts = splitTextByMatchIndices(text, getTextSearchMatchIndices(text, query));
  if (parts.length === 1 && !parts[0].matched) {
    return <span className={className}>{text}</span>;
  }

  return (
    <span className={className}>
      {parts.map((part, index) =>
        part.matched ? (
          <mark key={index} className="scoped-search-mark">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </span>
  );
}

/**
 * 区域搜索：默认隐藏，在宿主区域内 hover / 聚焦时按 Ctrl+F（Mac: ⌘F）在右上方显示搜索框�?
 * 搜索词非空时，自动在宿主内容区高亮匹配文本（Monaco 等编辑器区域除外）�?
 */
export const ScopedSearch = forwardRef<ScopedSearchHandle, ScopedSearchProps>(function ScopedSearch({
  value,
  onChange,
  placeholder,
  className,
  enabled = true,
  children,
}, ref) {
  const { t } = useI18n();
  const inputId = useId();
  const hostRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [visible, setVisible] = useState(false);
  const enabledRef = useRef(enabled);
  const visibleRef = useRef(visible);
  const valueRef = useRef(value);
  const applyingHighlightRef = useRef(false);

  enabledRef.current = enabled;
  visibleRef.current = visible;
  valueRef.current = value;

  const contextValue = useMemo<ScopedSearchContextValue>(
    () => ({ query: value }),
    [value],
  );

  const focusInput = useCallback(() => {
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) {
        return;
      }
      input.focus({ preventScroll: true });
      input.select();
    });
  }, []);

  const closeSearch = useCallback(() => {
    onChange("");
    setVisible(false);
  }, [onChange]);

  const openSearch = useCallback(() => {
    setVisible(true);
    focusInput();
  }, [focusInput]);

  useImperativeHandle(ref, () => ({
    open: (initialChar?: string) => {
      const wasVisible = visibleRef.current;
      if (initialChar !== undefined) {
        onChange(wasVisible ? valueRef.current + initialChar : initialChar);
      }
      setVisible(true);
      requestAnimationFrame(() => {
        const input = inputRef.current;
        if (!input) {
          return;
        }
        input.focus({ preventScroll: true });
        const len = input.value.length;
        input.setSelectionRange(len, len);
      });
    },
    close: () => {
      onChange("");
      setVisible(false);
    },
  }), [onChange]);

  useEffect(() => {
    return registerScopedSearch({
      getRoot: () => hostRef.current,
      isEnabled: () => enabledRef.current,
      isVisible: () => visibleRef.current,
      onActivate: openSearch,
      onEscape: closeSearch,
    });
  }, [openSearch, closeSearch]);

  useLayoutEffect(() => {
    const root = contentRef.current;
    if (!root) {
      return;
    }

    let observer: MutationObserver | null = null;
    let rafId = 0;

    const apply = () => {
      observer?.disconnect();
      applyingHighlightRef.current = true;
      applyScopedSearchHighlights(root, value);
      applyingHighlightRef.current = false;
      if (value.trim() && observer) {
        observer.observe(root, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      }
    };

    apply();

    if (!value.trim()) {
      return () => {
        cancelAnimationFrame(rafId);
        clearScopedSearchHighlights(root);
      };
    }

    observer = new MutationObserver(() => {
      if (applyingHighlightRef.current) {
        return;
      }
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(apply);
    });

    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => {
      cancelAnimationFrame(rafId);
      observer?.disconnect();
      clearScopedSearchHighlights(root);
    };
  }, [value, children]);

  return (
    <ScopedSearchContext.Provider value={contextValue}>
      <div
        ref={hostRef}
        className={`scoped-search-host${className ? ` ${className}` : ""}`}
      >
        {visible && (
          <div className="scoped-search-bar" role="search">
            <label className="scoped-search-bar__label" htmlFor={inputId}>
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
              id={inputId}
              ref={inputRef}
              clearable={false}
              copyable={false}
              className="scoped-search-bar__input"
              value={value}
              onChange={onChange}
              placeholder={placeholder}
              spellCheck={false}
              autoComplete="off"
            />
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
        )}
        <div ref={contentRef} className="scoped-search-content">
          {children}
        </div>
      </div>
    </ScopedSearchContext.Provider>
  );
});
