import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { rankByFuzzy } from "../../lib/fuzzyMatch";
import { useI18n } from "../../i18n";

export interface SelectOption {
  value: string;
  label: string;
  subtitle?: string;
  disabled?: boolean;
}

export type SelectOptionsInput = readonly SelectOption[] | readonly string[];

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOptionsInput;
  placeholder?: string;
  /** 启用搜索；默认选项数 > searchThreshold 时自动开启 */
  searchable?: boolean;
  searchThreshold?: number;
  disabled?: boolean;
  size?: "sm" | "md";
  className?: string;
  style?: CSSProperties;
  /** 下拉列表最小宽度与触发器一致 */
  matchTriggerWidth?: boolean;
  emptyText?: string;
  searchPlaceholder?: string;
  "aria-label"?: string;
  title?: string;
}

function normalizeOptions(options: SelectOptionsInput): SelectOption[] {
  if (options.length === 0) return [];
  const first = options[0];
  if (typeof first === "string") {
    return (options as readonly string[]).map((item) => ({
      value: item,
      label: item,
    }));
  }
  return [...(options as readonly SelectOption[])];
}

function ChevronIcon() {
  return (
    <svg
      className="omni-select-chevron"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

export function Select({
  value,
  onChange,
  options: optionsInput,
  placeholder,
  searchable,
  searchThreshold = 8,
  disabled = false,
  size = "md",
  className,
  style,
  matchTriggerWidth = true,
  emptyText,
  searchPlaceholder,
  "aria-label": ariaLabel,
  title,
}: SelectProps) {
  const { t } = useI18n();
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({
    visibility: "hidden",
  });

  const options = useMemo(() => normalizeOptions(optionsInput), [optionsInput]);
  const enableSearch =
    searchable ?? options.filter((opt) => !opt.disabled).length > searchThreshold;

  const filteredOptions = useMemo(() => {
    const enabled = options.filter((opt) => !opt.disabled);
    if (!enableSearch || !query.trim()) return options;
    const ranked = rankByFuzzy(enabled, query, (opt) =>
      `${opt.label} ${opt.subtitle ?? ""} ${opt.value}`,
    );
    const rankedSet = new Set(ranked.map((opt) => opt.value));
    const disabledOpts = options.filter((opt) => opt.disabled);
    return [...ranked, ...disabledOpts.filter((opt) => !rankedSet.has(opt.value))];
  }, [enableSearch, options, query]);

  const selectableOptions = useMemo(
    () => filteredOptions.filter((opt) => !opt.disabled),
    [filteredOptions],
  );

  const selectedOption = useMemo(
    () => options.find((opt) => opt.value === value) ?? null,
    [options, value],
  );

  const displayLabel = selectedOption?.label ?? placeholder ?? "";

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setHighlightIndex(0);
  }, []);

  const selectOption = useCallback(
    (opt: SelectOption) => {
      if (opt.disabled) return;
      onChange(opt.value);
      close();
      requestAnimationFrame(() => triggerRef.current?.focus());
    },
    [close, onChange],
  );

  const updatePanelPosition = useCallback(() => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;

    const rect = trigger.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const gap = 4;
    const padding = 8;
    const viewportH = window.innerHeight;
    const viewportW = window.innerWidth;

    let top = rect.bottom + gap;
    if (top + panelRect.height > viewportH - padding) {
      const above = rect.top - gap - panelRect.height;
      if (above >= padding) top = above;
    }

    let left = rect.left;
    const width = matchTriggerWidth
      ? Math.max(rect.width, 160)
      : Math.max(panelRect.width, 160);
    if (left + width > viewportW - padding) {
      left = Math.max(padding, viewportW - padding - width);
    }

    setPanelStyle({
      position: "fixed",
      top,
      left,
      width: matchTriggerWidth ? width : undefined,
      minWidth: matchTriggerWidth ? undefined : width,
      visibility: "visible",
      zIndex: 1200,
    });
  }, [matchTriggerWidth]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePanelPosition();
  }, [open, filteredOptions.length, enableSearch, updatePanelPosition]);

  useEffect(() => {
    if (!open) return;
    const onScroll = () => updatePanelPosition();
    window.addEventListener("resize", updatePanelPosition);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", updatePanelPosition);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, updatePanelPosition]);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      if (enableSearch) {
        searchRef.current?.focus();
      } else {
        panelRef.current?.focus();
      }
    });
  }, [enableSearch, open]);

  useEffect(() => {
    if (!open) return;
    const selectedIndex = selectableOptions.findIndex((opt) => opt.value === value);
    setHighlightIndex(selectedIndex >= 0 ? selectedIndex : 0);
  }, [open, selectableOptions, value]);

  useEffect(() => {
    if (highlightIndex >= selectableOptions.length) {
      setHighlightIndex(Math.max(0, selectableOptions.length - 1));
    }
  }, [highlightIndex, selectableOptions.length]);

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpen(true);
    }
  };

  const handlePanelKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      triggerRef.current?.focus();
      return;
    }
    if (selectableOptions.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightIndex((prev) => (prev + 1) % selectableOptions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightIndex(
        (prev) => (prev - 1 + selectableOptions.length) % selectableOptions.length,
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      const opt = selectableOptions[highlightIndex];
      if (opt) selectOption(opt);
    }
  };

  const rootClass = [
    "omni-select",
    `omni-select--${size}`,
    open ? "is-open" : "",
    disabled ? "is-disabled" : "",
    !selectedOption && placeholder ? "is-placeholder" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  const panel = open
    ? createPortal(
        <>
          <div className="omni-select-backdrop" onMouseDown={close} />
          <div
            ref={panelRef}
            className="omni-select-panel"
            style={panelStyle}
            role="listbox"
            id={listboxId}
            tabIndex={-1}
            onKeyDown={handlePanelKeyDown}
          >
            {enableSearch && (
              <div className="omni-select-search">
                <input
                  ref={searchRef}
                  type="text"
                  className="omni-select-search-input"
                  value={query}
                  placeholder={
                    searchPlaceholder ?? t("ui.select.searchPlaceholder")
                  }
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setHighlightIndex(0);
                  }}
                  onKeyDown={handlePanelKeyDown}
                />
              </div>
            )}
            <div className="omni-select-options">
              {filteredOptions.length === 0 ? (
                <div className="omni-select-empty">
                  {emptyText ?? t("ui.select.noResults")}
                </div>
              ) : (
                filteredOptions.map((opt) => {
                  const selectableIndex = selectableOptions.findIndex(
                    (item) => item.value === opt.value,
                  );
                  const highlighted =
                    !opt.disabled && selectableIndex === highlightIndex;
                  return (
                    <button
                      key={`${opt.value}::${opt.label}`}
                      type="button"
                      role="option"
                      aria-selected={opt.value === value}
                      disabled={opt.disabled}
                      className={[
                        "omni-select-option",
                        opt.value === value ? "is-selected" : "",
                        highlighted ? "is-highlighted" : "",
                        opt.disabled ? "is-disabled" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      onMouseEnter={() => {
                        if (!opt.disabled && selectableIndex >= 0) {
                          setHighlightIndex(selectableIndex);
                        }
                      }}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => selectOption(opt)}
                    >
                      <span className="omni-select-option-label">{opt.label}</span>
                      {opt.subtitle ? (
                        <span className="omni-select-option-sub">{opt.subtitle}</span>
                      ) : null}
                      {opt.value === value ? (
                        <svg
                          className="omni-select-option-check"
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          aria-hidden
                        >
                          <path d="M3.5 8.5l3 3 6-7" />
                        </svg>
                      ) : null}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </>,
        document.body,
      )
    : null;

  return (
    <div ref={rootRef} className={rootClass} style={style} title={title}>
      <button
        ref={triggerRef}
        type="button"
        className="omni-select-trigger"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        onClick={() => {
          if (disabled) return;
          setOpen((prev) => !prev);
        }}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="omni-select-value">{displayLabel}</span>
        <ChevronIcon />
      </button>
      {panel}
    </div>
  );
}
