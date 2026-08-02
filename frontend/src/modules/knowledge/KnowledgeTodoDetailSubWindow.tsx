import { useCallback, useEffect, useRef, useState } from "react";
import { SubWindow } from "../../components/ui/SubWindow";
import { TextInput } from "../../components/ui/form/TextInput";
import { useI18n } from "../../i18n";
import { appConfirm } from "../../lib/appConfirm";
import type { KnowledgeTodoList } from "../../ipc/bindings";
import { createTodoItem } from "../../stores/knowledgeTodoStore";

const AUTOSAVE_MS = 600;

type KnowledgeTodoDetailSubWindowProps = {
  open: boolean;
  list: KnowledgeTodoList | null;
  onClose: () => void;
  onSave: (list: KnowledgeTodoList) => Promise<boolean>;
  onDeleteList: (id: string) => Promise<void>;
};

function normalizeDraft(list: KnowledgeTodoList): KnowledgeTodoList {
  return {
    ...list,
    description: list.description ?? "",
    items: list.items.map((item) => ({ ...item })),
  };
}

function todoItemLabel(item: KnowledgeTodoList["items"][number]): string {
  return item.name ?? ("text" in item ? item.text : undefined) ?? "";
}

function sanitizeForSave(draft: KnowledgeTodoList, fallbackTitle: string): KnowledgeTodoList {
  const title = draft.title.trim() || fallbackTitle;
  const description = (draft.description ?? "").trim();
  const items = draft.items
    .map((item) => ({
      ...item,
      name: todoItemLabel(item).trim(),
      executor: (item.executor ?? "").trim(),
      description: (item.description ?? "").trim(),
    }))
    .filter((item) => item.name.length > 0 || item.executor.length > 0 || item.description.length > 0);
  return {
    ...draft,
    title,
    description,
    items,
  };
}

export function KnowledgeTodoDetailSubWindow({
  open,
  list,
  onClose,
  onSave,
  onDeleteList,
}: KnowledgeTodoDetailSubWindowProps) {
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

  const updateMeta = (patch: Partial<Pick<KnowledgeTodoList, "title" | "description">>) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      scheduleSave(next);
      return next;
    });
  };

  const updateItemField = (
    id: string,
    field: "name" | "executor" | "description",
    value: string,
  ) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = {
        ...prev,
        items: prev.items.map((item) => (item.id === id ? { ...item, [field]: value } : item)),
      };
      scheduleSave(next);
      return next;
    });
  };

  const handleDeleteList = async () => {
    if (!draft) return;
    if (!(await appConfirm(t("knowledge.todos.confirmDelete")))) return;
    await onDeleteList(draft.id);
    onClose();
  };

  const handleRemoveItem = async (itemId: string) => {
    if (!draft) return;
    if (!(await appConfirm(t("knowledge.todos.confirmDeleteItem")))) return;
    const next = {
      ...draft,
      items: draft.items.filter((item) => item.id !== itemId),
    };
    setDraft(next);
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    await flushSave(next);
  };

  const handleSubmitItem = () => {
    // 提交逻辑暂留空
  };

  const handleAddItem = () => {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = { ...prev, items: [...prev.items, createTodoItem()] };
      scheduleSave(next);
      return next;
    });
  };

  if (!draft) {
    return (
      <SubWindow
        open={open}
        title={t("knowledge.todos.editList")}
        onClose={onClose}
        className="knowledge-todo-detail-subwindow"
        widthRatio={0.78}
        heightRatio={0.76}
      >
        <div className="knowledge-todo-detail__empty">{t("common.loading")}</div>
      </SubWindow>
    );
  }

  return (
    <SubWindow
      open={open}
      title={draft.title.trim() || t("knowledge.todos.untitled")}
      onClose={handleClose}
      className="knowledge-todo-detail-subwindow"
      widthRatio={0.78}
      heightRatio={0.76}
      headerExtra={
        <button
          type="button"
          className="knowledge-todo-detail__header-delete"
          title={t("knowledge.delete")}
          aria-label={t("knowledge.delete")}
          onClick={() => void handleDeleteList()}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14" aria-hidden>
            <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
          </svg>
        </button>
      }
    >
      <div className="knowledge-todo-detail">
        <section className="knowledge-todo-detail__meta">
          <label className="knowledge-todo-detail__label">
            {t("knowledge.todos.listTitlePlaceholder")}
            <TextInput
              ref={titleRef}
              clearable={false}
              copyable={false}
              className="knowledge-todo-detail__title"
              value={draft.title}
              placeholder={t("knowledge.todos.listTitlePlaceholder")}
              onChange={(title) => updateMeta({ title })}
            />
          </label>
          <label className="knowledge-todo-detail__label">
            {t("knowledge.todos.listDescriptionPlaceholder")}
            <textarea
              className="knowledge-todo-detail__description"
              value={draft.description ?? ""}
              placeholder={t("knowledge.todos.listDescriptionPlaceholder")}
              rows={2}
              onChange={(e) => updateMeta({ description: e.target.value })}
            />
          </label>
        </section>

        <div className="knowledge-todo-detail__toolbar">
          <span className="knowledge-todo-detail__item-count">
            {t("knowledge.todos.itemCount", { count: draft.items.length })}
          </span>
          <button type="button" className="knowledge-todo-detail__add" onClick={handleAddItem}>
            {t("knowledge.todos.addItem")}
          </button>
        </div>

        <div className="knowledge-todo-detail__table-wrap">
          <table className="knowledge-todo-detail__table">
            <colgroup>
              <col className="knowledge-todo-detail__col-name" />
              <col className="knowledge-todo-detail__col-executor" />
              <col className="knowledge-todo-detail__col-description" />
              <col className="knowledge-todo-detail__col-status" />
              <col className="knowledge-todo-detail__col-actions" />
            </colgroup>
            <thead>
              <tr>
                <th>{t("knowledge.todos.itemNamePlaceholder")}</th>
                <th>{t("knowledge.todos.itemExecutorPlaceholder")}</th>
                <th>{t("knowledge.todos.itemDescriptionPlaceholder")}</th>
                <th>{t("knowledge.todos.status")}</th>
                <th className="knowledge-todo-detail__col-actions">{t("knowledge.todos.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {draft.items.length === 0 ? (
                <tr>
                  <td colSpan={5} className="knowledge-todo-detail__empty-row">
                    {t("knowledge.todos.emptyItems")}
                  </td>
                </tr>
              ) : (
                draft.items.map((item) => (
                  <tr key={item.id} className={item.done ? "is-done" : undefined}>
                    <td>
                      <TextInput
                        clearable={false}
                        copyable={false}
                        className="knowledge-todo-detail__cell-input"
                        value={todoItemLabel(item)}
                        placeholder={t("knowledge.todos.itemNamePlaceholder")}
                        onChange={(name) => updateItemField(item.id, "name", name)}
                      />
                    </td>
                    <td>
                      <TextInput
                        clearable={false}
                        copyable={false}
                        className="knowledge-todo-detail__cell-input"
                        value={item.executor ?? ""}
                        placeholder={t("knowledge.todos.itemExecutorPlaceholder")}
                        onChange={(executor) => updateItemField(item.id, "executor", executor)}
                      />
                    </td>
                    <td>
                      <textarea
                        className="knowledge-todo-detail__cell-textarea"
                        value={item.description ?? ""}
                        placeholder={t("knowledge.todos.itemDescriptionPlaceholder")}
                        rows={2}
                        onChange={(e) => updateItemField(item.id, "description", e.target.value)}
                      />
                    </td>
                    <td>
                      <span className={`knowledge-todo-detail__status${item.done ? " is-done" : ""}`}>
                        {item.done ? t("knowledge.todos.statusDone") : t("knowledge.todos.statusPending")}
                      </span>
                    </td>
                    <td className="knowledge-todo-detail__col-actions">
                      <div className="knowledge-todo-detail__row-actions">
                        <button
                          type="button"
                          className="knowledge-todo-detail__icon-btn"
                          title={t("knowledge.todos.submitItem")}
                          aria-label={t("knowledge.todos.submitItem")}
                          onClick={handleSubmitItem}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14" aria-hidden>
                            <path d="M5 12l5 5L20 7" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="knowledge-todo-detail__icon-btn knowledge-todo-detail__icon-btn--danger"
                          title={t("knowledge.todos.removeItem")}
                          aria-label={t("knowledge.todos.removeItem")}
                          onClick={() => void handleRemoveItem(item.id)}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14" aria-hidden>
                            <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
                          </svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </SubWindow>
  );
}
