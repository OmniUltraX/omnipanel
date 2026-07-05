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
import {
  normalizeOptions,
  type SelectOption,
  type SelectOptionsInput,
} from "./Select";

export interface MultiSelectProps {
  values: string[];
  onChange: (values: string[]) => void;
  options: SelectOptionsInput;
  placeholder?: string;
  disabled?: boolean;
  size?: "sm" | "md";
  className?: string;
  style?: CSSProperties;
  panelZIndex?: number;
  panelMinWidth?: number;
  "aria-label"?: string;
  title?: string;
  /** 空数组时视为全选，用于展示勾选状态 */
  allValues?: readonly string[];
  formatDisplayLabel?: (selectedLabels: string[], allSelected: boolean) => string;
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

export function MultiSelect({
  values,
  onChange,
  options: optionsInput,
  placeholder,
  disabled = false,
  size = "md",
  className,
  style,
  panelZIndex = 10000,
  panelMinWidth,
  "aria-label": ariaLabel,
  title,
  allValues,
  formatDisplayLabel,
}: MultiSelectProps) {
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const [open, setOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [dropUp, setDropUp] = useState(false);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({ visibility: "hidden" });

  const options = useMemo(() => normalizeOptions(optionsInput), [optionsInput]);
  const optionValues = useMemo(
    () => allValues ?? options.filter((opt) => !opt.disabled).map((opt) => opt.value),
    [allValues, options],
  );

  const allSelected =
    values.length === 0 ||
    (optionValues.length > 0 && values.length >= optionValues.length);

  const isSelected = useCallback(
    (value: string) => {
      if (allSelected) {
        return true;
      }
      return values.includes(value);
    },
    [allSelected, values],
  );

  const displayLabel = useMemo(() => {
    if (allSelected) {
      return formatDisplayLabel?.([], true) ?? placeholder ?? "";
    }
    const labels = values
      .map((value) => options.find((opt) => opt.value === value)?.label ?? value)
      .filter(Boolean);
    if (formatDisplayLabel) {
      return formatDisplayLabel(labels, false);
    }
    return labels.join("、") || placeholder || "";
  }, [allSelected, values, options, formatDisplayLabel, placeholder]);

  const close = useCallback(() => {
    setOpen(false);
    setHighlightIndex(0);
  }, []);

  const toggleOption = useCallback(
    (opt: SelectOption) => {
      if (opt.disabled) {
        return;
      }
      const universe = optionValues.length > 0 ? optionValues : [opt.value];
      const currentAll = values.length === 0 || values.length >= universe.length;

      if (currentAll) {
        onChange(universe.filter((value) => value !== opt.value));
        return;
      }

      if (values.includes(opt.value)) {
        const next = values.filter((value) => value !== opt.value);
        onChange(next.length === 0 ? [] : next);
        return;
      }

      const next = [...values, opt.value];
      onChange(next.length >= universe.length ? [] : next);
    },
    [onChange, optionValues, values],
  );

  const updatePanelPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) {
      return;
    }
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
    if (!open) {
      return;
    }
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
    if (!open) {
      return;
    }
    requestAnimationFrame(() => panelRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
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

  const selectableOptions = useMemo(
    () => options.filter((opt) => !opt.disabled),
    [options],
  );

  const handlePanelKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      triggerRef.current?.focus();
      return;
    }
    if (selectableOptions.length === 0) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightIndex((prev) => (prev + 1) % selectableOptions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightIndex(
        (prev) => (prev - 1 + selectableOptions.length) % selectableOptions.length,
      );
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const opt = selectableOptions[highlightIndex];
      if (opt) {
        toggleOption(opt);
      }
    }
  };

  const rootClass = [
    "omni-select",
    "omni-select--multi",
    `omni-select--${size}`,
    open ? "is-open" : "",
    disabled ? "is-disabled" : "",
    !displayLabel && placeholder ? "is-placeholder" : "",
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
          if (disabled) {
            return;
          }
          setOpen((prev) => !prev);
        }}
        onKeyDown={(event) => {
          if (disabled) {
            return;
          }
          if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="omni-select-value">{displayLabel}</span>
        <ChevronIcon />
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            className={`omni-select-panel omni-select-panel--portal omni-select-panel--multi${dropUp ? " omni-select-panel--up" : ""}`}
            style={panelStyle}
            role="listbox"
            id={listboxId}
            tabIndex={-1}
            onKeyDown={handlePanelKeyDown}
          >
            <div className="omni-select-options">
              {options.map((opt) => {
                const selectableIndex = selectableOptions.findIndex(
                  (item) => item.value === opt.value,
                );
                const highlighted = !opt.disabled && selectableIndex === highlightIndex;
                const selected = isSelected(opt.value);
                const optionTitle =
                  opt.title ?? [opt.label, opt.subtitle].filter(Boolean).join(" · ");
                return (
                  <button
                    key={`${opt.value}::${opt.label}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    disabled={opt.disabled}
                    title={optionTitle || undefined}
                    className={[
                      "omni-select-option",
                      selected ? "is-selected" : "",
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
                    onClick={() => toggleOption(opt)}
                  >
                    <span className="omni-select-option-label" style={opt.labelStyle}>
                      {opt.label}
                    </span>
                    {opt.subtitle ? (
                      <span className="omni-select-option-sub">{opt.subtitle}</span>
                    ) : null}
                    {selected ? (
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
              })}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
