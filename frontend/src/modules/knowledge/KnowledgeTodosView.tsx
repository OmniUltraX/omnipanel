import { useCallback, useEffect, useMemo } from "react";
import { useI18n } from "../../i18n";
import { useKnowledgeTodoStore } from "../../stores/knowledgeTodoStore";
import { KnowledgeTodoCard, KnowledgeTodoNewCard } from "./KnowledgeTodoCard";
import { KnowledgeTodoEditor } from "./KnowledgeTodoEditor";

export function KnowledgeTodosView() {
  const { t } = useI18n();
  const lists = useKnowledgeTodoStore((s) => s.lists);
  const isLoading = useKnowledgeTodoStore((s) => s.isLoading);
  const error = useKnowledgeTodoStore((s) => s.error);
  const editingId = useKnowledgeTodoStore((s) => s.editingId);
  const loadLists = useKnowledgeTodoStore((s) => s.loadLists);
  const saveList = useKnowledgeTodoStore((s) => s.saveList);
  const deleteList = useKnowledgeTodoStore((s) => s.deleteList);
  const createList = useKnowledgeTodoStore((s) => s.createList);
  const toggleItem = useKnowledgeTodoStore((s) => s.toggleItem);
  const setEditingId = useKnowledgeTodoStore((s) => s.setEditingId);
  const clearError = useKnowledgeTodoStore((s) => s.clearError);

  useEffect(() => {
    void loadLists();
  }, [loadLists]);

  const editingList = useMemo(
    () => lists.find((l) => l.id === editingId) ?? null,
    [editingId, lists],
  );

  const handleCreate = useCallback(() => {
    void createList();
  }, [createList]);

  return (
    <div className="knowledge-todos">
      {error && (
        <div className="knowledge-error knowledge-error--floating">
          <span>{error}</span>
          <button type="button" onClick={clearError}>×</button>
        </div>
      )}

      {isLoading && lists.length === 0 ? (
        <div className="knowledge-todos-loading">{t("common.loading")}</div>
      ) : (
        <div className="knowledge-todo-masonry">
          {lists.map((list) => (
            <KnowledgeTodoCard
              key={list.id}
              list={list}
              onEdit={() => setEditingId(list.id)}
              onToggleItem={(itemId) => void toggleItem(list.id, itemId)}
              onDelete={() => void deleteList(list.id)}
            />
          ))}
          <KnowledgeTodoNewCard onClick={handleCreate} />
        </div>
      )}

      <KnowledgeTodoEditor
        open={editingId != null}
        list={editingList}
        onClose={() => setEditingId(null)}
        onSave={saveList}
        onDelete={deleteList}
      />
    </div>
  );
}
