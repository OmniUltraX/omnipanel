import { useEffect, useRef, type KeyboardEvent } from "react";
import { useI18n } from "../../../i18n";
import { TextInput } from "../../../components/ui/form/TextInput";
import type { CommandHistoryEntry } from "./commandHistory";

type CommandHistoryPopoverProps = {
  entries: CommandHistoryEntry[];
  activeIndex: number;
  filter: string;
  onFilterChange: (value: string) => void;
  onHighlightIndex: (index: number) => void;
  onSelect: (entry: CommandHistoryEntry) => void;
  onNavigateKeyDown: (event: KeyboardEvent) => void;
  visible: boolean;
};

const KIND_LABEL_KEYS = {
  shell: "terminal.command.historyKindShell",
  ai: "terminal.command.historyKindAi",
  readline: "terminal.command.historyKindReadline",
} as const;

export function CommandHistoryPopover({
  entries,
  activeIndex,
  filter,
  onFilterChange,
  onHighlightIndex,
  onSelect,
  onNavigateKeyDown,
  visible,
}: CommandHistoryPopoverProps) {
  const { t } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!visible) return;
    const active = listRef.current?.querySelector<HTMLElement>(".is-active");
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, visible, entries.length]);

  if (!visible) return null;

  return (
    <div
      className="term-cmd-history"
      role="dialog"
      aria-label={t("terminal.command.historyTitle")}
      onKeyDown={onNavigateKeyDown}
    >
      <div className="term-cmd-history__header">
        <span className="term-cmd-history__title">{t("terminal.command.historyTitle")}</span>
        <span className="term-cmd-history__hint">{t("terminal.command.historyHint")}</span>
      </div>
      <TextInput
        copyable={false}
        className="term-cmd-history__search"
        value={filter}
        placeholder={t("terminal.command.historySearch")}
        onChange={onFilterChange}
        onKeyDown={(event) => {
          if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "r") {
            event.preventDefault();
            onNavigateKeyDown(event);
            return;
          }
          if (["ArrowUp", "ArrowDown", "Enter", "Escape"].includes(event.key)) {
            event.preventDefault();
            onNavigateKeyDown(event);
            return;
          }
          event.stopPropagation();
        }}
      />
      <div className="term-cmd-history__list" ref={listRef} role="listbox">
        {entries.length === 0 ? (
          <div className="term-cmd-history__empty">{t("terminal.command.historyEmpty")}</div>
        ) : (
          entries.map((entry, index) => (
            <button
              key={`${entry.kind}:${entry.text}:${index}`}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={`term-cmd-history__item${index === activeIndex ? " is-active" : ""}`}
              onMouseEnter={() => onHighlightIndex(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                onSelect(entry);
              }}
            >
              <code>{entry.text}</code>
              <span className={`term-cmd-history__kind term-cmd-history__kind--${entry.kind}`}>
                {t(KIND_LABEL_KEYS[entry.kind])}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
