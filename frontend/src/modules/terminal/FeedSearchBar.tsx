import { useEffect, useRef } from "react";
import { useI18n } from "../../i18n";
import { IconClose } from "../../components/ui/icons/Icons";
import type { FeedKindFilter, FeedSearchFilters } from "./feedSearchModel";

type FeedSearchBarProps = {
  filters: FeedSearchFilters;
  matchCount: number;
  focusIndex: number;
  onChange: (patch: Partial<FeedSearchFilters>) => void;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
};

export function FeedSearchBar({
  filters,
  matchCount,
  focusIndex,
  onChange,
  onPrev,
  onNext,
  onClose,
}: FeedSearchBarProps) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const positionLabel =
    matchCount > 0
      ? t("terminal.feed.search.position", {
          current: focusIndex + 1,
          total: matchCount,
        })
      : t("terminal.feed.search.noMatchShort");

  return (
    <div className="term-feed-search" role="search">
      <div className="term-feed-search__row">
        <input
          ref={inputRef}
          type="search"
          className="term-feed-search__input"
          value={filters.query}
          placeholder={t("terminal.feed.search.placeholder")}
          aria-label={t("terminal.feed.search.placeholder")}
          onChange={(event) => onChange({ query: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (event.shiftKey) onPrev();
              else onNext();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <span className="term-feed-search__count" aria-live="polite">
          {positionLabel}
        </span>
        <button
          type="button"
          className="term-feed-search__nav"
          aria-label={t("terminal.feed.search.prev")}
          title={t("terminal.feed.search.prev")}
          disabled={matchCount === 0}
          onClick={onPrev}
        >
          ↑
        </button>
        <button
          type="button"
          className="term-feed-search__nav"
          aria-label={t("terminal.feed.search.next")}
          title={t("terminal.feed.search.next")}
          disabled={matchCount === 0}
          onClick={onNext}
        >
          ↓
        </button>
        <button
          type="button"
          className="term-feed-search__close"
          aria-label={t("terminal.feed.search.close")}
          title={t("terminal.feed.search.close")}
          onClick={onClose}
        >
          <IconClose size={14} />
        </button>
      </div>
      <div className="term-feed-search__filters" role="toolbar" aria-label={t("terminal.feed.search.filterLabel")}>
        {(["all", "shell", "ai"] as const).map((item) => (
          <button
            key={item}
            type="button"
            className={`term-feed-search__chip${filters.kind === item ? " term-feed-search__chip--active" : ""}`}
            aria-pressed={filters.kind === item}
            onClick={() => onChange({ kind: item as FeedKindFilter })}
          >
            {t(`terminal.feed.search.kind.${item}`)}
          </button>
        ))}
        <button
          type="button"
          className={`term-feed-search__chip${filters.failedOnly ? " term-feed-search__chip--active" : ""}`}
          aria-pressed={filters.failedOnly}
          onClick={() => onChange({ failedOnly: !filters.failedOnly })}
        >
          {t("terminal.feed.search.failedOnly")}
        </button>
      </div>
    </div>
  );
}
