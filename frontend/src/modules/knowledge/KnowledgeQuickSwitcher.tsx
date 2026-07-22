import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../i18n";
import { useKnowledgeStore } from "../../stores/knowledgeStore";
import { isKnowledgeFolder } from "./knowledgeTree";

interface KnowledgeQuickSwitcherProps {
  open: boolean;
  onClose: () => void;
  onOpen: (entryId: string) => void;
  onCreate: (title: string) => void;
}

export function KnowledgeQuickSwitcher({
  open,
  onClose,
  onOpen,
  onCreate,
}: KnowledgeQuickSwitcherProps) {
  const { t } = useI18n();
  const entries = useKnowledgeStore((s) => s.entries);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const documents = useMemo(
    () => entries.filter((entry) => !isKnowledgeFolder(entry)),
    [entries],
  );

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return documents.slice(0, 20);
    return documents
      .filter((entry) => entry.title.toLowerCase().includes(q))
      .slice(0, 20);
  }, [documents, query]);

  const canCreate =
    query.trim().length > 0 &&
    !documents.some((entry) => entry.title.trim().toLowerCase() === query.trim().toLowerCase());

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  if (!open) return null;

  const total = results.length + (canCreate ? 1 : 0);

  return createPortal(
    <div className="knowledge-switcher-backdrop" onClick={onClose}>
      <div
        className="knowledge-switcher"
        role="dialog"
        aria-label={t("knowledge.switcher.title")}
        onClick={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="knowledge-switcher__input"
          value={query}
          placeholder={t("knowledge.switcher.placeholder")}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
              return;
            }
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setIndex((value) => (total === 0 ? 0 : (value + 1) % total));
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setIndex((value) => (total === 0 ? 0 : (value - 1 + total) % total));
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              if (canCreate && index === results.length) {
                onCreate(query.trim());
                onClose();
                return;
              }
              const hit = results[index];
              if (hit) {
                onOpen(hit.id);
                onClose();
              }
            }
          }}
        />
        <ul className="knowledge-switcher__list">
          {results.map((entry, i) => (
            <li key={entry.id}>
              <button
                type="button"
                className={`knowledge-switcher__item${i === index ? " is-active" : ""}`}
                onMouseEnter={() => setIndex(i)}
                onClick={() => {
                  onOpen(entry.id);
                  onClose();
                }}
              >
                {entry.title}
              </button>
            </li>
          ))}
          {canCreate ? (
            <li>
              <button
                type="button"
                className={`knowledge-switcher__item${index === results.length ? " is-active" : ""}`}
                onMouseEnter={() => setIndex(results.length)}
                onClick={() => {
                  onCreate(query.trim());
                  onClose();
                }}
              >
                {t("knowledge.switcher.create", { title: query.trim() })}
              </button>
            </li>
          ) : null}
          {total === 0 ? (
            <li className="knowledge-rail-empty">{t("knowledge.noResults")}</li>
          ) : null}
        </ul>
      </div>
    </div>,
    document.body,
  );
}
