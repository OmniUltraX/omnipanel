import type { MouseEvent } from "react";
import type { KnowledgeTodoItem, KnowledgeTodoList } from "../../ipc/bindings";
import { useI18n } from "../../i18n";
import { appConfirm } from "../../lib/appConfirm";

type KnowledgeTodoCardProps = {
  list: KnowledgeTodoList;
  onEdit: () => void;
  onToggleItem: (itemId: string) => void;
  onDelete: () => void;
};

function TodoCheck({
  done,
  onToggle,
}: {
  done: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`knowledge-todo-check${done ? " knowledge-todo-check--done" : ""}`}
      aria-checked={done}
      role="checkbox"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      {done && (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="10" height="10" aria-hidden>
          <path d="M5 13l4 4L19 7" />
        </svg>
      )}
    </button>
  );
}

export function KnowledgeTodoCard({ list, onEdit, onToggleItem, onDelete }: KnowledgeTodoCardProps) {
  const { t } = useI18n();
  const items = list.items.filter((item) => item.text.trim());
  const doneCount = items.filter((item) => item.done).length;

  const handleDelete = async (e: MouseEvent) => {
    e.stopPropagation();
    if (!(await appConfirm(t("knowledge.todos.confirmDelete")))) return;
    onDelete();
  };

  return (
    <article
      className="knowledge-todo-card"
      onClick={onEdit}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onEdit();
        }
      }}
      role="button"
      tabIndex={0}
    >
      <header className="knowledge-todo-card__header">
        <h4 className="knowledge-todo-card__title">{list.title || t("knowledge.todos.untitled")}</h4>
        {items.length > 0 && (
          <span className="knowledge-todo-card__progress">
            {t("knowledge.todos.progress", { done: doneCount, total: items.length })}
          </span>
        )}
      </header>
      <ul className="knowledge-todo-card__items">
        {items.length === 0 ? (
          <li className="knowledge-todo-card__empty">{t("knowledge.todos.emptyItems")}</li>
        ) : (
          items.map((item: KnowledgeTodoItem) => (
            <li
              key={item.id}
              className={`knowledge-todo-card__item${item.done ? " knowledge-todo-card__item--done" : ""}`}
            >
              <TodoCheck done={item.done} onToggle={() => onToggleItem(item.id)} />
              <span className="knowledge-todo-card__text">{item.text}</span>
            </li>
          ))
        )}
      </ul>
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
