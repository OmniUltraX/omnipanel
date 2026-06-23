"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";

export type EffortLevel = "default" | "low" | "medium" | "high";

export interface ModelSelectorItem {
  id: string;
  name: string;
  description?: string;
  efforts?: boolean;
}

export interface ModelSelectorProps {
  models: ModelSelectorItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  effort?: EffortLevel;
  defaultEffort?: EffortLevel;
  onEffortChange?: (level: EffortLevel) => void;
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
}

const SIZE_MAP = {
  sm: { trigger: "h-7 text-xs px-1.5 gap-0.5", list: "min-w-[14rem] text-xs", item: "py-1 px-2" },
  md: { trigger: "h-9 text-sm px-2 gap-1", list: "min-w-[16rem] text-sm", item: "py-1.5 px-2.5" },
  lg: { trigger: "h-10 text-sm px-2.5 gap-1", list: "min-w-[18rem] text-sm", item: "py-2 px-3" },
} as const;

const EFFORT_LEVELS: EffortLevel[] = ["default", "low", "medium", "high"];

function EffortBars({ level }: { level: EffortLevel }) {
  if (level === "default") {
    return (
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" aria-hidden>
        <path d="M8 1.5l1.1 2.4 2.6.4-1.9 1.8.4 2.6L8 7.6 5.8 8.7l.4-2.6-1.9-1.8 2.6-.4L8 1.5z" />
        <circle cx="8" cy="8" r="1.1" fill="currentColor" opacity="0.85" />
      </svg>
    );
  }
  const bars = { low: 1, medium: 2, high: 3 };
  const count = bars[level];
  return (
    <span className="inline-flex items-end gap-[1.5px] h-3" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          className="w-[3px] rounded-[1px] bg-current"
          style={{
            height: `${40 + i * 30}%`,
            opacity: 0.78,
          }}
        />
      ))}
    </span>
  );
}

function effortTitle(level: EffortLevel): string {
  switch (level) {
    case "default": return "Default";
    case "low": return "Low";
    case "medium": return "Medium";
    case "high": return "High";
  }
}

export function ModelSelector({
  models,
  value: controlledValue,
  defaultValue,
  onValueChange,
  effort: controlledEffort,
  defaultEffort,
  onEffortChange,
  size = "sm",
  disabled = false,
}: ModelSelectorProps) {
  const id = useId();
  const isControlled = controlledValue !== undefined;
  const [internalValue, setInternalValue] = useState(defaultValue ?? models[0]?.id ?? "");
  const value = isControlled ? controlledValue : internalValue;
  const activeModel = useMemo(() => models.find((m) => m.id === value), [models, value]);

  const [internalEffort, setInternalEffort] = useState<EffortLevel>(defaultEffort ?? "medium");
  const effort = controlledEffort !== undefined ? controlledEffort : internalEffort;

  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const sizes = SIZE_MAP[size];

  const handleSelect = useCallback(
    (modelId: string) => {
      if (!isControlled) setInternalValue(modelId);
      onValueChange?.(modelId);
      setOpen(false);
    },
    [isControlled, onValueChange],
  );

  const handleEffort = useCallback(
    (level: EffortLevel) => {
      if (controlledEffort === undefined) setInternalEffort(level);
      onEffortChange?.(level);
    },
    [controlledEffort, onEffortChange],
  );

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent | FocusEvent) => {
      if (
        listRef.current &&
        !listRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("focusin", handler);
    document.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("focusin", handler);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [open]);

  const selectedModelSupportsEffort = activeModel?.efforts === true;

  return (
    <div className="relative inline-flex items-center" role="group" aria-label="Model selector">
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={`${id}-list`}
        aria-label="Select model"
        disabled={disabled}
        onClick={() => setOpen((p) => !p)}
        className={cn(
          "aui-model-selector-trigger inline-flex items-center rounded-md border border-transparent text-left",
          "hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "disabled:pointer-events-none disabled:opacity-50",
          "transition-colors",
          sizes.trigger,
          open && "bg-accent/50",
        )}
      >
        <span className="truncate max-w-[120px]">{activeModel?.name ?? value}</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={cn("shrink-0 transition-transform", open && "rotate-180")}
          aria-hidden
        >
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>

      {open && (
        <div
          ref={listRef}
          id={`${id}-list`}
          role="listbox"
          aria-label="Model options"
          className={cn(
            "aui-model-selector-list absolute left-0 bottom-full z-[var(--z-subwindow-popover)] mb-1",
            "bg-popover text-popover-foreground rounded-xl border p-1 shadow-lg backdrop-blur-sm",
            "animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-1",
            "max-h-[320px] overflow-y-auto overscroll-contain",
            sizes.list,
          )}
        >
          {models.map((model) => (
            <button
              key={model.id}
              type="button"
              role="option"
              aria-selected={model.id === value}
              onClick={() => handleSelect(model.id)}
              className={cn(
                "aui-model-selector-item flex w-full items-center gap-2 rounded-lg text-left outline-none transition-colors",
                "hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground",
                sizes.item,
                model.id === value && "bg-accent text-accent-foreground",
              )}
            >
              <span className="flex flex-col min-w-0 flex-1">
                <span className="truncate font-medium leading-tight">{model.name}</span>
                {model.description && (
                  <span className="truncate text-[0.8em] text-muted-foreground leading-tight">
                    {model.description}
                  </span>
                )}
              </span>
              {model.efforts && (
                <span className="shrink-0 text-muted-foreground" title="Supports reasoning effort">
                  <EffortBars level="medium" />
                </span>
              )}
            </button>
          ))}

          {selectedModelSupportsEffort && (
            <div className="mt-1 border-t border-border pt-1">
              <div className="flex items-center gap-1 px-2 py-1">
                {EFFORT_LEVELS.map((level) => (
                  <button
                    key={level}
                    type="button"
                    onClick={() => handleEffort(level)}
                    className={cn(
                      "flex items-center gap-1 rounded-md px-2 py-1 text-[0.85em] transition-colors",
                      "hover:bg-accent hover:text-accent-foreground",
                      effort === level
                        ? "bg-accent text-accent-foreground font-medium"
                        : "text-muted-foreground",
                    )}
                    title={effortTitle(level)}
                    aria-pressed={effort === level}
                  >
                    <EffortBars level={level} />
                    <span>{effortTitle(level)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
