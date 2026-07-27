import type { MouseEvent } from "react";
import type { KnowledgeTodoList } from "../../ipc/bindings";
import { useI18n } from "../../i18n";
import { appConfirm } from "../../lib/appConfirm";

type KnowledgeTodoCardProps = {
  list: KnowledgeTodoList;
  onOpen: () => void;
  onDelete: () => void;
};

export function KnowledgeTodoCard({ list, onOpen, onDelete }: KnowledgeTodoCardProps) {
  const { t } = useI18n();
  const itemCount = list.items.length;
  const description = (list.description ?? "").trim();

  const handleDelete = async (e: MouseEvent) => {
    e.stopPropagation();
    if (!(await appConfirm(t("knowledge.todos.confirmDelete")))) return;
    onDelete();
  };

  return (
    <article
      className="knowledge-todo-card"
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      role="button"
      tabIndex={0}
    >
      <header className="knowledge-todo-card__header">
        <h4 className="knowledge-todo-card__title">{list.title || t("knowledge.todos.untitled")}</h4>
        <span className="knowledge-todo-card__count">
          {t("knowledge.todos.itemCount", { count: itemCount })}
        </span>
      </header>
      {description ? (
        <p className="knowledge-todo-card__summary">{description}</p>
      ) : (
        <p className="knowledge-todo-card__summary knowledge-todo-card__summary--empty">
          {t("knowledge.todos.noDescription")}
        </p>
      )}
      <button
        type="button"
        className="knowledge-todo-card__delete"
        title={t("knowledge.delete")}
        aria-label={t("knowledge.delete")}
        onClick={handleDelete}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14" aria-hidden>
          <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
        </svg>
      </button>
    </article>
  );
}

export function KnowledgeTodoNewCard({ onClick }: { onClick: () => void }) {
  const { t } = useI18n();

  return (
    <button type="button" className="knowledge-todo-card knowledge-todo-card--new" onClick={onClick}>
      <span className="knowledge-todo-card__new-icon" aria-hidden>+</span>
      <span className="knowledge-todo-card__new-label">{t("knowledge.todos.newList")}</span>
    </button>
  );
}
