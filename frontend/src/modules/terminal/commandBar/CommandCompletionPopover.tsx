import { useEffect, useRef, type KeyboardEvent } from "react";
import { TextInput } from "../../../components/ui/TextInput";
import { useI18n } from "../../../i18n";
import type { CompletionCandidate } from "./types";

interface Props {
  candidates: CompletionCandidate[];
  activeIndex: number;
  filter: string;
  onFilterChange: (value: string) => void;
  onSelect: (candidate: CompletionCandidate) => void;
  onNavigateKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  visible: boolean;
}

const SOURCE_LABELS: Record<CompletionCandidate["source"], string> = {
  history: "历史",
  command: "命令",
  path: "路径",
  resource: "资源",
  template: "模板",
  ai: "AI",
};

export function CommandCompletionPopover({
  candidates,
  activeIndex,
  filter,
  onFilterChange,
  onSelect,
  onNavigateKeyDown,
  visible,
}: Props) {
  const { t } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!visible) return;
    const active = listRef.current?.querySelector<HTMLElement>(".is-active");
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, visible, candidates.length]);

  if (!visible) return null;

  return (
    <div className="term-cmd-completion" role="listbox">
      <div className="term-cmd-completion__toolbar">
        <TextInput
          copyable={false}
          className="term-cmd-completion__search"
          value={filter}
          placeholder={t("terminal.command.completionSearch")}
          onChange={onFilterChange}
          onKeyDown={(event) => {
            if (["ArrowUp", "ArrowDown", "Enter", "Escape"].includes(event.key)) {
              onNavigateKeyDown(event);
              return;
            }
            event.stopPropagation();
          }}
        />
      </div>
      <div className="term-cmd-completion__list" ref={listRef}>
        {candidates.length === 0 ? (
          <div className="term-cmd-completion__empty">{t("terminal.command.completionEmpty")}</div>
        ) : (
          candidates.map((candidate, index) => (
          <button
            key={candidate.id}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            className={`term-cmd-completion-item${index === activeIndex ? " is-active" : ""}`}
            onMouseDown={(event) => {
              event.preventDefault();
              onSelect(candidate);
            }}
          >
            <span className="term-cmd-completion-label">{candidate.label}</span>
            {candidate.description ? (
              <span className="term-cmd-completion-desc">{candidate.description}</span>
            ) : null}
            <span className="term-cmd-completion-source">{SOURCE_LABELS[candidate.source]}</span>
          </button>
        ))
        )}
      </div>
    </div>
  );
}
