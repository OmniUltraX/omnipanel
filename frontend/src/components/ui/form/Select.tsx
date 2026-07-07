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
import { rankByFuzzy } from "../../../lib/fuzzyMatch";
import { useI18n } from "../../../i18n";

export interface SelectOption {
  value: string;
  label: string;
  subtitle?: string;
  title?: string;
  disabled?: boolean;
  labelStyle?: CSSProperties;
}

export type SelectOptionsInput = readonly SelectOption[] | readonly string[];

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOptionsInput;
  placeholder?: string;
  searchable?: boolean;
  searchThreshold?: number;
  disabled?: boolean;
  size?: "sm" | "md";
  borderless?: boolean;
  className?: string;
  style?: CSSProperties;
  emptyText?: string;
  searchPlaceholder?: string;
  panelZIndex?: number;
  panelMinWidth?: number;
  "aria-label"?: string;
  title?: string;
}

export function normalizeOptions(options: SelectOptionsInput): SelectOption[] {
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
  disabled = false,
  size = "md",
  borderless = false,
  className,
  style,
  emptyText,
  searchPlaceholder,
  panelZIndex = 10000,
  panelMinWidth,
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
  const [dropUp, setDropUp] = useState(false);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({ visibility: "hidden" });

  const options = useMemo(() => normalizeOptions(optionsInput), [optionsInput]);
  const enableSearch = searchable !== false;

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

  const enabledOptions = useMemo(
    () => options.filter((opt) => !opt.disabled),
    [options],
  );

  const moveSelectableIndex = useCallback(
    (current: number, delta: number, length: number) => {
      if (length <= 0) {
        return 0;
      }
      return (current + delta + length) % length;
    },
    [],
  );

  const selectRelativeEnabledOption = useCallback(
    (delta: number) => {
      if (enabledOptions.length === 0) {
        return;
      }
      const currentIndex = enabledOptions.findIndex((opt) => opt.value === value);
      const nextIndex =
        currentIndex < 0
          ? delta > 0
            ? 0
            : enabledOptions.length - 1
          : moveSelectableIndex(currentIndex, delta, enabledOptions.length);
      const nextOption = enabledOptions[nextIndex];
      if (nextOption && nextOption.value !== value) {
        onChange(nextOption.value);
      }
    },
    [enabledOptions, moveSelectableIndex, onChange, value],
  );

  const scrollHighlightedOptionIntoView = useCallback(() => {
    const panel = panelRef.current;
    if (!panel) {
      return;
    }
    panel
      .querySelector<HTMLElement>(".omni-select-option.is-highlighted")
      ?.scrollIntoView({ block: "nearest" });
  }, []);

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
      if (opt.value === value) {
        close();
        requestAnimationFrame(() => triggerRef.current?.focus());
        return;
      }
      onChange(opt.value);
      close();
      requestAnimationFrame(() => triggerRef.current?.focus());
    },
    [close, onChange, value],
  );

  const updatePanelPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const shouldDropUp = spaceBelow < 240 && rect.top > spaceBelow;
    setDropUp(shouldDropUp);
    setPanelStyle({
      position: "fixed",
      left: rect.left,
      width: Math.max(rect.width, panelMinWidth ?? 0),
      zIndex: panelZIndex,
      visibility: "visible",
      ...(shouldDropUp
        ? { bottom: window.innerHeight - rect.top + 2, top: "auto" }
        : { top: rect.bottom + 2, bottom: "auto" }),
    });
  }, [panelMinWidth, panelZIndex]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePanelPosition();
    const onScrollOrResize = () => updatePanelPosition();
    window.addEventListener("resize", onScrollOrResize);
    window.addEventListener("scroll", onScrollOrResize, true);
    return () => {
      window.removeEventListener("resize", onScrollOrResize);
      window.removeEventListener("scroll", onScrollOrResize, true);
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

  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    scrollHighlightedOptionIntoView();
  }, [open, highlightIndex, filteredOptions, scrollHighlightedOptionIntoView]);

  // Close on outside click (panel is portaled to document.body)
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      const root = rootRef.current;
      const panel = panelRef.current;
      if (root?.contains(target) || panel?.contains(target)) {
        return;
      }
      close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, close]);

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;

    if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      selectRelativeEnabledOption(event.key === "ArrowDown" ? 1 : -1);
      return;
    }

    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpen(true);
      return;
    }
    if (
      enableSearch &&
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      setQuery(event.key);
      setHighlightIndex(0);
      setOpen(true);
    }
  };

  const handlePanelKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      triggerRef.current?.focus();
      return;
    }
    if (selectableOptions.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      setHighlightIndex((prev) => moveSelectableIndex(prev, 1, selectableOptions.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      setHighlightIndex((prev) => moveSelectableIndex(prev, -1, selectableOptions.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      const opt = selectableOptions[highlightIndex];
      if (opt) selectOption(opt);
    }
  };

  const rootClass = [
    "omni-select",
    `omni-select--${size}`,
    open ? "is-open" : "",
    disabled ? "is-disabled" : "",
    borderless ? "is-borderless" : "",
    !selectedOption && placeholder ? "is-placeholder" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

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
      {open &&
        createPortal(
          <div
            ref={panelRef}
            className={`omni-select-panel omni-select-panel--portal${dropUp ? " omni-select-panel--up" : ""}`}
            style={panelStyle}
            role="listbox"
            id={listboxId}
            tabIndex={enableSearch ? undefined : -1}
            onKeyDown={enableSearch ? undefined : handlePanelKeyDown}
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
                  const optionTitle =
                    opt.title ??
                    [opt.label, opt.subtitle].filter(Boolean).join(" · ");
                  return (
                    <button
                      key={`${opt.value}::${opt.label}`}
                      type="button"
                      role="option"
                      aria-selected={opt.value === value}
                      disabled={opt.disabled}
                      title={optionTitle || undefined}
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
                      <span className="omni-select-option-label" style={opt.labelStyle}>
                        {opt.label}
                      </span>
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
          </div>,
          document.body,
        )}
    </div>
  );
}
