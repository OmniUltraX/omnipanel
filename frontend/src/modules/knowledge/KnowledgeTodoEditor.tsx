import { useCallback, useEffect, useRef, useState } from "react";
import { TextInput } from "../../components/ui/form/TextInput";
import { useI18n } from "../../i18n";
import { appConfirm } from "../../lib/appConfirm";
import type { KnowledgeTodoList } from "../../ipc/bindings";
import { createTodoItem } from "../../stores/knowledgeTodoStore";

const AUTOSAVE_MS = 600;

type KnowledgeTodoEditorProps = {
  open: boolean;
  list: KnowledgeTodoList | null;
  onClose: () => void;
  onSave: (list: KnowledgeTodoList) => Promise<boolean>;
  onDelete: (id: string) => Promise<void>;
};

function normalizeDraft(list: KnowledgeTodoList): KnowledgeTodoList {
  const items = list.items.length > 0 ? list.items.map((item) => ({ ...item })) : [createTodoItem()];
  return { ...list, items };
}

function sanitizeForSave(draft: KnowledgeTodoList, fallbackTitle: string): KnowledgeTodoList {
  const title = draft.title.trim() || fallbackTitle;
  const items = draft.items
    .map((item) => ({ ...item, text: item.text.trim() }))
    .filter((item) => item.text.length > 0);
  return {
    ...draft,
    title,
    items: items.length > 0 ? items : [],
  };
}

export function KnowledgeTodoEditor({ open, list, onClose, onSave, onDelete }: KnowledgeTodoEditorProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<KnowledgeTodoList | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open && list) {
      setDraft(normalizeDraft(list));
      requestAnimationFrame(() => titleRef.current?.focus());
    } else if (!open) {
      setDraft(null);
    }
  }, [open, list]);

  const flushSave = useCallback(
    async (next: KnowledgeTodoList) => {
      return onSave(sanitizeForSave(next, t("knowledge.todos.untitled")));
    },
    [onSave, t],
  );

  const scheduleSave = useCallback(
    (next: KnowledgeTodoList) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        void flushSave(next);
      }, AUTOSAVE_MS);
    },
    [flushSave],
  );

  const handleClose = useCallback(() => {
    if (draft) {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      void flushSave(draft);
    }
    onClose();
  }, [draft, flushSave, onClose]);

  useEffect(
    () => () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleClose();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, handleClose]);

  if (!open || !draft) return null;

  const updateItemText = (id: string, text: string) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = {
        ...prev,
        items: prev.items.map((item) => (item.id === id ? { ...item, text } : item)),
      };
      scheduleSave(next);
      return next;
    });
  };

  const insertItemAfter = (id: string) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const idx = prev.items.findIndex((item) => item.id === id);
      const nextItems = [...prev.items];
      nextItems.splice(idx + 1, 0, createTodoItem());
      const next = { ...prev, items: nextItems };
      scheduleSave(next);
      return next;
    });
  };

  const removeItem = (id: string) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const nextItems = prev.items.filter((item) => item.id !== id);
      const next = { ...prev, items: nextItems.length > 0 ? nextItems : [createTodoItem()] };
      scheduleSave(next);
      return next;
    });
  };

  const handleDelete = async () => {
    if (!(await appConfirm(t("knowledge.todos.confirmDelete")))) return;
    await onDelete(draft.id);
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div
        className="knowledge-todo-note"
        role="dialog"
        aria-label={t("knowledge.todos.editList")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="knowledge-todo-note__actions">
          <button
            type="button"
            className="knowledge-todo-note__action"
            title={t("knowledge.delete")}
            onClick={() => void handleDelete()}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="16" height="16" aria-hidden>
              <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
            </svg>
          </button>
          <button type="button" className="knowledge-todo-note__action" title={t("knowledge.cancel")} onClick={handleClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" aria-hidden>
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <TextInput
          ref={titleRef}
          clearable={false}
          copyable={false}
          className="knowledge-todo-note__title"
          value={draft.title}
          placeholder={t("knowledge.todos.listTitlePlaceholder")}
          onChange={(title) => {
            const next = { ...draft, title };
            setDraft(next);
            scheduleSave(next);
          }}
        />

        <div className="knowledge-todo-note__items">
          {draft.items.map((item, index) => (
            <div key={item.id} className="knowledge-todo-note__row">
              <span className="knowledge-todo-note__bullet" aria-hidden />
              <TextInput
                clearable={false}
                copyable={false}
                className="knowledge-todo-note__text"
                value={item.text}
                placeholder={index === draft.items.length - 1 ? t("knowledge.todos.itemPlaceholder") : ""}
                onChange={(text) => updateItemText(item.id, text)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    insertItemAfter(item.id);
                    requestAnimationFrame(() => {
                      const rows = document.querySelectorAll<HTMLInputElement>(
                        ".knowledge-todo-note__text",
                      );
                      rows[index + 1]?.focus();
                    });
                  } else if (e.key === "Backspace" && !item.text && draft.items.length > 1) {
                    e.preventDefault();
                    removeItem(item.id);
                    requestAnimationFrame(() => {
                      const rows = document.querySelectorAll<HTMLInputElement>(
                        ".knowledge-todo-note__text",
                      );
                      rows[Math.max(0, index - 1)]?.focus();
                    });
                  }
                }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
