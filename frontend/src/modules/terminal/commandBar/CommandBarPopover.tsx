import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { TextInput } from "../../../components/ui/form/TextInput";
import { useI18n } from "../../../i18n";
import {
  POPOVER_BADGE_I18N,
  type CommandBarPopoverItem,
  type CommandBarPopoverMode,
} from "./commandBarPopoverModel";
import { FuzzyHighlightText } from "./FuzzyHighlightText";
import {
  popoverFixedStyle,
  useCommandBarPopoverAnchor,
} from "./useCommandBarPopoverAnchor";

const PICKER_MAX_HEIGHT = 320;

type CommandBarPopoverProps = {
  anchorRef: RefObject<HTMLElement | null>;
  mode: CommandBarPopoverMode;
  items: CommandBarPopoverItem[];
  activeIndex: number;
  page: number;
  totalPages: number;
  filter: string;
  onFilterChange: (value: string) => void;
  onHighlightIndex: (index: number) => void;
  onSelect: (index: number) => void;
  onNavigateKeyDown: (event: KeyboardEvent) => void;
  visible: boolean;
};

export function CommandBarPopover({
  anchorRef,
  mode,
  items,
  activeIndex,
  page,
  totalPages,
  filter,
  onFilterChange,
  onHighlightIndex,
  onSelect,
  onNavigateKeyDown,
  visible,
}: CommandBarPopoverProps) {
  const { t } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);
  const anchor = useCommandBarPopoverAnchor(anchorRef, visible);

  useEffect(() => {
    if (!visible) return;
    const active = listRef.current?.querySelector<HTMLElement>(".is-active");
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, visible, items.length]);

  if (!visible || !anchor) return null;

  const title =
    mode === "history"
      ? t("terminal.command.historyTitle")
      : t("terminal.command.pickerTitleCompletion");
  const emptyText =
    mode === "history"
      ? t("terminal.command.historyEmpty")
      : t("terminal.command.pickerEmpty");

  const panel = (
    <div
      className="term-cmd-picker term-cmd-picker--portal"
      role="listbox"
      aria-label={title}
      style={popoverFixedStyle(anchor, PICKER_MAX_HEIGHT)}
    >
      <div className="term-cmd-picker__header">
        <span className="term-cmd-picker__title">{title}</span>
        <span className="term-cmd-picker__hint">{t("terminal.command.pickerHint")}</span>
      </div>
      <TextInput
        copyable={false}
        className="term-cmd-picker__search"
        value={filter}
        placeholder={t("terminal.command.pickerSearch")}
        onChange={onFilterChange}
        onKeyDown={(event) => {
          if (
            mode === "history" &&
            event.ctrlKey &&
            !event.shiftKey &&
            !event.altKey &&
            event.key.toLowerCase() === "r"
          ) {
            event.preventDefault();
            onNavigateKeyDown(event);
            return;
          }
          if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Escape", "Tab"].includes(event.key)) {
            event.preventDefault();
            onNavigateKeyDown(event);
            return;
          }
          event.stopPropagation();
        }}
      />
      <div className="term-cmd-picker__list" ref={listRef}>
        {items.length === 0 ? (
          <div className="term-cmd-picker__empty">{emptyText}</div>
        ) : (
          items.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={`term-cmd-picker__item${index === activeIndex ? " is-active" : ""}`}
              onMouseEnter={() => onHighlightIndex(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                onSelect(index);
              }}
            >
              <code className="term-cmd-picker__label">
                <FuzzyHighlightText text={item.label} query={filter} />
              </code>
              <span className="term-cmd-picker__meta">
                {item.description ? (
                  <span className="term-cmd-picker__desc">{item.description}</span>
                ) : null}
                <span className={`term-cmd-picker__badge term-cmd-picker__badge--${item.badge}`}>
                  {t(POPOVER_BADGE_I18N[item.badge])}
                </span>
              </span>
            </button>
          ))
        )}
      </div>
      {items.length > 0 && totalPages > 1 ? (
        <div className="term-cmd-picker__footer">
          <span className="term-cmd-picker__page">
            {t("terminal.command.pickerPage", { page: page + 1, total: totalPages })}
          </span>
          <span className="term-cmd-picker__page-hint">{t("terminal.command.pickerPageHint")}</span>
        </div>
      ) : null}
    </div>
  );

  return createPortal(panel, document.body);
}
