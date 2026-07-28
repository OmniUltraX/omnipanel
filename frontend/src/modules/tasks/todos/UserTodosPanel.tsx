import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  IconBell,
  IconCheckCircle,
  IconClipboard,
  IconClock,
  IconClose,
  IconHome,
  IconLightning,
  IconPlus,
  IconRefresh,
  IconTrash,
} from "../../../components/ui/icons/Icons";
import { useI18n } from "../../../i18n";
import type { TodoTask } from "../../../ipc/bindings";
import {
  localYmd,
  startOfLocalDay,
  useUserTodoStore,
} from "../../../stores/userTodoStore";
import type { InboxMineView } from "../taskCenterSelection";
import { mineViewToQuery, resolveMineView } from "../taskCenterSelection";
import {
  ComposerIconPopover,
  DueDateMenu,
  RemindMenu,
  RepeatMenu,
  TodoAttrMenus,
} from "./TodoAttrMenus";

function formatDueFull(ts: number, locale: string, t: (k: string, p?: Record<string, string | number>) => string): string {
  const d = new Date(ts);
  const today = startOfLocalDay();
  const day = startOfLocalDay(d);
  const diff = Math.round((day - today) / 86_400_000);
  if (diff === 0) return t("taskCenter.todo.dueToday");
  if (diff === 1) return t("taskCenter.todo.dueTomorrow");
  if (diff === -1) return t("taskCenter.todo.dueYesterday");
  return d.toLocaleDateString(locale === "zh-CN" ? "zh-CN" : "en-US", {
    month: "long",
    day: "numeric",
    weekday: "short",
  });
}

function formatRemindFull(ts: number, locale: string, t: (k: string, p?: Record<string, string | number>) => string): string {
  const d = new Date(ts);
  const today = startOfLocalDay();
  const day = startOfLocalDay(d);
  const diff = Math.round((day - today) / 86_400_000);
  if (diff === 0) {
    return d.toLocaleTimeString(locale === "zh-CN" ? "zh-CN" : "en-US", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  if (diff === 1) return t("taskCenter.todo.dueTomorrow");
  return d.toLocaleDateString(locale === "zh-CN" ? "zh-CN" : "en-US", {
    month: "short",
    day: "numeric",
    weekday: "short",
  });
}

function dateSubtitle(locale: string): string {
  const d = new Date();
  return d.toLocaleDateString(locale === "zh-CN" ? "zh-CN" : "en-US", {
    month: "long",
    day: "numeric",
    weekday: "long",
  });
}

function viewIcon(view: InboxMineView): ReactNode {
  if (view === "myDay") return <IconLightning size={22} />;
  if (view === "important") return <IconCheckCircle size={22} />;
  if (view === "planned") return <IconClock size={22} />;
  if (view === "tasks") return <IconHome size={22} />;
  return <IconClipboard size={22} />;
}

function formatComposerChip(
  kind: "due" | "remind" | "repeat",
  value: number | string,
  locale: string,
  t: (k: string, p?: Record<string, string | number>) => string,
): string {
  if (kind === "repeat") {
    return t(`taskCenter.todo.repeat.${value}` as "taskCenter.todo.repeat.daily");
  }
  const d = new Date(value as number);
  if (kind === "due") {
    return d.toLocaleDateString(locale === "zh-CN" ? "zh-CN" : "en-US", {
      month: "short",
      day: "numeric",
    });
  }
  return d.toLocaleString(locale === "zh-CN" ? "zh-CN" : "en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export interface UserTodosPanelProps {
  mineView: InboxMineView;
  taskId?: string;
  onSelectTask: (taskId: string | undefined) => void;
}

export function UserTodosPanel({ mineView, taskId, onSelectTask }: UserTodosPanelProps) {
  const { t, locale } = useI18n();
  const lists = useUserTodoStore((s) => s.lists);
  const tasks = useUserTodoStore((s) => s.tasks);
  const selectedTask = useUserTodoStore((s) => s.selectedTask);
  const isLoading = useUserTodoStore((s) => s.isLoading);
  const error = useUserTodoStore((s) => s.error);
  const clearError = useUserTodoStore((s) => s.clearError);
  const loadLists = useUserTodoStore((s) => s.loadLists);
  const loadTasks = useUserTodoStore((s) => s.loadTasks);
  const selectTask = useUserTodoStore((s) => s.selectTask);
  const createTask = useUserTodoStore((s) => s.createTask);
  const toggleComplete = useUserTodoStore((s) => s.toggleComplete);
  const toggleImportant = useUserTodoStore((s) => s.toggleImportant);
  const saveTask = useUserTodoStore((s) => s.saveTask);
  const deleteTask = useUserTodoStore((s) => s.deleteTask);
  const toggleMyDay = useUserTodoStore((s) => s.toggleMyDay);
  const setDueAt = useUserTodoStore((s) => s.setDueAt);
  const setRemindAt = useUserTodoStore((s) => s.setRemindAt);
  const setRecurrence = useUserTodoStore((s) => s.setRecurrence);
  const addStep = useUserTodoStore((s) => s.addStep);
  const renameStep = useUserTodoStore((s) => s.renameStep);
  const toggleStep = useUserTodoStore((s) => s.toggleStep);
  const removeStep = useUserTodoStore((s) => s.removeStep);

  const [draft, setDraft] = useState("");
  const [draftDue, setDraftDue] = useState<number | null>(null);
  const [draftRemind, setDraftRemind] = useState<number | null>(null);
  const [draftRepeat, setDraftRepeat] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const renameList = useUserTodoStore((s) => s.renameList);

  const view = resolveMineView({ view: mineView });
  const query = useMemo(() => {
    const q = mineViewToQuery(view);
    return {
      ...q,
      includeCompleted: true as const,
      today: localYmd(),
    };
  }, [view]);

  useEffect(() => {
    void loadLists();
  }, [loadLists]);

  useEffect(() => {
    void loadTasks(query);
  }, [loadTasks, query.view, query.listId, query.today]);

  useEffect(() => {
    void selectTask(taskId ?? null);
  }, [taskId, selectTask]);

  // 切换列表时清空草稿属性
  useEffect(() => {
    setDraftDue(null);
    setDraftRemind(null);
    setDraftRepeat(null);
    setEditingTitle(false);
  }, [view]);

  const title = useMemo(() => {
    if (view === "myDay") return t("taskCenter.todo.myDay");
    if (view === "important") return t("taskCenter.todo.important");
    if (view === "planned") return t("taskCenter.todo.planned");
    if (view === "tasks") {
      return (
        lists.find((l) => l.isDefault)?.title || t("taskCenter.todo.tasks")
      );
    }
    const listId = view.slice(5);
    return lists.find((l) => l.id === listId)?.title || t("taskCenter.todo.untitledList");
  }, [view, lists, t]);

  /** 自定义列表与默认「任务」箱可改名；智能视图不可改 */
  const titleEditable = view === "tasks" || view.startsWith("list:");

  const editableListId = useMemo(() => {
    if (view.startsWith("list:")) return view.slice(5);
    if (view === "tasks") return lists.find((l) => l.isDefault)?.id;
    return undefined;
  }, [view, lists]);

  const openTasks = tasks.filter((x) => !x.completed);
  const doneTasks = tasks.filter((x) => x.completed);

  const targetListId = useMemo(() => {
    if (view.startsWith("list:")) return view.slice(5);
    return lists.find((l) => l.isDefault)?.id;
  }, [view, lists]);

  const commitTitle = async () => {
    const next = titleDraft.trim();
    setEditingTitle(false);
    if (!editableListId || !next || next === title) return;
    await renameList(editableListId, next);
  };

  const startEditTitle = () => {
    if (!titleEditable) return;
    setTitleDraft(title);
    setEditingTitle(true);
    requestAnimationFrame(() => {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    });
  };

  const handleAdd = async () => {
    const id = await createTask(draft, targetListId, {
      dueAt: draftDue,
      remindAt: draftRemind,
      recurrenceFreq: draftRepeat,
    });
    if (id) {
      setDraft("");
      setDraftDue(null);
      setDraftRemind(null);
      setDraftRepeat(null);
      onSelectTask(id);
      inputRef.current?.focus();
    }
  };

  const detail = selectedTask;

  return (
    <div className="task-center-user-todos user-todo-layout">
      {error && (
        <div className="knowledge-error knowledge-error--floating">
          <span>{error}</span>
          <button type="button" onClick={clearError}>
            ×
          </button>
        </div>
      )}

      <div className="user-todo-main">
        <header className="user-todo-header">
          <div className="user-todo-header__row">
            <span className="user-todo-header__icon" aria-hidden>
              {viewIcon(view)}
            </span>
            {editingTitle ? (
              <input
                ref={titleInputRef}
                className="user-todo-header__title-input"
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={() => void commitTitle()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void commitTitle();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setEditingTitle(false);
                  }
                }}
                aria-label={t("taskCenter.todo.renameList")}
              />
            ) : (
              <h2
                className={`user-todo-header__title${titleEditable ? " is-editable" : ""}`}
                title={titleEditable ? t("taskCenter.todo.clickToRename") : undefined}
                onClick={startEditTitle}
                onKeyDown={(e) => {
                  if (!titleEditable) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    startEditTitle();
                  }
                }}
                role={titleEditable ? "button" : undefined}
                tabIndex={titleEditable ? 0 : undefined}
              >
                {title}
              </h2>
            )}
          </div>
          {view === "myDay" && (
            <p className="user-todo-header__sub">{dateSubtitle(locale)}</p>
          )}
        </header>

        <div className="user-todo-list">
          {isLoading && tasks.length === 0 ? (
            <p className="user-todo-empty">{t("common.loading")}</p>
          ) : openTasks.length === 0 && doneTasks.length === 0 ? (
            <p className="user-todo-empty">{t("taskCenter.todo.emptyTasks")}</p>
          ) : (
            <>
              {openTasks.map((task) => (
                <TodoRow
                  key={task.id}
                  task={task}
                  active={task.id === taskId}
                  view={view}
                  lists={lists}
                  locale={locale}
                  t={t}
                  onSelect={() => onSelectTask(task.id)}
                  onToggleComplete={() => void toggleComplete(task.id)}
                  onToggleImportant={() => void toggleImportant(task.id)}
                />
              ))}
              {doneTasks.length > 0 && (
                <details className="user-todo-done-group" open={false}>
                  <summary>
                    {t("taskCenter.todo.completedGroup", { count: doneTasks.length })}
                  </summary>
                  {doneTasks.map((task) => (
                    <TodoRow
                      key={task.id}
                      task={task}
                      active={task.id === taskId}
                      view={view}
                      lists={lists}
                      locale={locale}
                      t={t}
                      onSelect={() => onSelectTask(task.id)}
                      onToggleComplete={() => void toggleComplete(task.id)}
                      onToggleImportant={() => void toggleImportant(task.id)}
                    />
                  ))}
                </details>
              )}
            </>
          )}
        </div>

        <div className="user-todo-composer">
          <span className="user-todo-composer__check" aria-hidden>
            <span className="user-todo-check__ring" />
          </span>
          <div className="user-todo-composer__body">
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={t("taskCenter.todo.addTask")}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleAdd();
                }
              }}
            />
            {(draftDue != null || draftRemind != null || draftRepeat) && (
              <div className="user-todo-composer__chips">
                {draftDue != null && (
                  <button
                    type="button"
                    className="user-todo-composer__chip"
                    onClick={() => setDraftDue(null)}
                    title={t("taskCenter.todo.addDue")}
                  >
                    <IconClock size={12} />
                    {formatComposerChip("due", draftDue, locale, t)}
                    <IconClose size={10} />
                  </button>
                )}
                {draftRemind != null && (
                  <button
                    type="button"
                    className="user-todo-composer__chip"
                    onClick={() => setDraftRemind(null)}
                    title={t("taskCenter.todo.remindMe")}
                  >
                    <IconBell size={12} />
                    {formatComposerChip("remind", draftRemind, locale, t)}
                    <IconClose size={10} />
                  </button>
                )}
                {draftRepeat && (
                  <button
                    type="button"
                    className="user-todo-composer__chip"
                    onClick={() => setDraftRepeat(null)}
                    title={t("taskCenter.todo.repeat.label")}
                  >
                    <IconRefresh size={12} />
                    {formatComposerChip("repeat", draftRepeat, locale, t)}
                    <IconClose size={10} />
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="user-todo-composer__actions">
            <ComposerIconPopover
              title={t("taskCenter.todo.addDue")}
              active={draftDue != null}
              icon={<IconClock size={16} />}
            >
              {(close) => <DueDateMenu onPick={setDraftDue} close={close} />}
            </ComposerIconPopover>
            <ComposerIconPopover
              title={t("taskCenter.todo.remindMe")}
              active={draftRemind != null}
              icon={<IconBell size={16} />}
            >
              {(close) => <RemindMenu onPick={setDraftRemind} close={close} />}
            </ComposerIconPopover>
            <ComposerIconPopover
              title={t("taskCenter.todo.repeat.label")}
              active={!!draftRepeat}
              icon={<IconRefresh size={16} />}
            >
              {(close) => <RepeatMenu onPick={setDraftRepeat} close={close} />}
            </ComposerIconPopover>
          </div>
        </div>
      </div>

      {detail && (
        <aside className="user-todo-detail">
          <div className="user-todo-detail__title-row">
            <button
              type="button"
              className={`user-todo-check${detail.completed ? " is-done" : ""}`}
              aria-label={t("taskCenter.todo.complete")}
              onClick={() => void toggleComplete(detail.id)}
            >
              {detail.completed ? <IconCheckCircle size={18} /> : <span className="user-todo-check__ring" />}
            </button>
            <input
              className="user-todo-detail__title"
              key={`title-${detail.id}`}
              defaultValue={detail.title}
              onBlur={(e) => {
                const next = e.target.value.trim();
                if (next && next !== detail.title) {
                  void saveTask({ ...detail, title: next }, false);
                }
              }}
            />
            <button
              type="button"
              className={`user-todo-star${detail.important ? " is-on" : ""}`}
              title={t("taskCenter.todo.important")}
              onClick={() => void toggleImportant(detail.id)}
            >
              ★
            </button>
            <button
              type="button"
              className="user-todo-detail__close"
              title={t("taskCenter.todo.close")}
              onClick={() => onSelectTask(undefined)}
            >
              <IconClose size={14} />
            </button>
          </div>

          <div className="user-todo-steps">
            {(detail.steps ?? []).map((step) => (
              <div key={step.id} className={`user-todo-step${step.done ? " is-done" : ""}`}>
                <button
                  type="button"
                  className="user-todo-check user-todo-check--sm"
                  onClick={() => void toggleStep(detail.id, step.id)}
                >
                  {step.done ? <IconCheckCircle size={14} /> : <span className="user-todo-check__ring" />}
                </button>
                <input
                  className="user-todo-step__title"
                  defaultValue={step.title}
                  onBlur={(e) => {
                    void renameStep(detail.id, step.id, e.target.value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                />
                <button
                  type="button"
                  className="user-todo-step__remove"
                  onClick={() => void removeStep(detail.id, step.id)}
                >
                  <IconClose size={12} />
                </button>
              </div>
            ))}
            <StepComposer
              placeholder={t("taskCenter.todo.nextStep")}
              onAdd={(title) => void addStep(detail.id, title)}
            />
          </div>

          <TodoAttrMenus
            task={detail}
            onToggleMyDay={() => void toggleMyDay(detail.id)}
            onSetDue={(ts) => void setDueAt(detail.id, ts)}
            onClearDue={() => void setDueAt(detail.id, null)}
            onSetRemind={(ts) => void setRemindAt(detail.id, ts)}
            onClearRemind={() => void setRemindAt(detail.id, null)}
            onSetRecurrence={(freq) => void setRecurrence(detail.id, freq)}
            onClearRecurrence={() => void setRecurrence(detail.id, null)}
          />

          <textarea
            className="user-todo-note"
            key={`note-${detail.id}`}
            placeholder={t("taskCenter.todo.addNote")}
            defaultValue={detail.note ?? ""}
            onBlur={(e) => {
              if (e.target.value !== (detail.note ?? "")) {
                void saveTask({ ...detail, note: e.target.value }, false);
              }
            }}
          />

          <footer className="user-todo-detail__footer">
            <span>
              {t("taskCenter.todo.createdAt", {
                time: new Date(detail.createdAt ?? Date.now()).toLocaleString(),
              })}
            </span>
            <button
              type="button"
              className="user-todo-detail__delete"
              title={t("common.delete")}
              onClick={() => {
                void deleteTask(detail.id);
                onSelectTask(undefined);
              }}
            >
              <IconTrash size={14} />
            </button>
          </footer>
        </aside>
      )}
    </div>
  );
}

function TodoRow({
  task,
  active,
  view,
  lists,
  locale,
  t,
  onSelect,
  onToggleComplete,
  onToggleImportant,
}: {
  task: TodoTask;
  active: boolean;
  view: InboxMineView;
  lists: { id: string; title: string; isDefault?: boolean | null }[];
  locale: string;
  t: (k: string, p?: Record<string, string | number>) => string;
  onSelect: () => void;
  onToggleComplete: () => void;
  onToggleImportant: () => void;
}) {
  const overdue =
    task.dueAt != null && !task.completed && task.dueAt < startOfLocalDay();
  const today = localYmd();
  const inMyDay = task.myDayOn === today;
  const list = lists.find((l) => l.id === task.listId);
  const listTitle = list
    ? list.title ||
      (list.isDefault ? t("taskCenter.todo.tasks") : t("taskCenter.todo.untitledList"))
    : t("taskCenter.todo.untitledList");
  // 智能视图下展示所属列表；自定义列表视图内不必重复
  const showListName = view === "myDay" || view === "important" || view === "planned";

  const meta: { key: string; node: ReactNode }[] = [];
  if (inMyDay && view !== "myDay") {
    meta.push({
      key: "myday",
      node: (
        <span className="user-todo-row__meta-item">
          <IconLightning size={12} />
          {t("taskCenter.todo.myDay")}
        </span>
      ),
    });
  }
  if (showListName) {
    meta.push({
      key: "list",
      node: (
        <span className="user-todo-row__meta-item">
          <IconClipboard size={12} />
          {listTitle}
        </span>
      ),
    });
  }
  const stepsTotal = task.stepsTotal ?? 0;
  const stepsDone = task.stepsDone ?? 0;
  if (stepsTotal > 0) {
    const current = Math.min(stepsDone + (stepsDone >= stepsTotal ? 0 : 1), stepsTotal);
    meta.push({
      key: "steps",
      node: (
        <span className="user-todo-row__meta-item">
          {t("taskCenter.todo.stepsProgress", {
            current: current || 1,
            done: stepsDone,
            total: stepsTotal,
          })}
        </span>
      ),
    });
  }
  if (task.dueAt != null) {
    meta.push({
      key: "due",
      node: (
        <span className={`user-todo-row__meta-item${overdue ? " is-overdue" : ""}`}>
          <IconClock size={12} />
          {formatDueFull(task.dueAt, locale, t)}
        </span>
      ),
    });
  }
  if (task.recurrence) {
    meta.push({
      key: "rep",
      node: (
        <span className="user-todo-row__meta-item">
          <IconRefresh size={12} />
          {t(`taskCenter.todo.repeat.${task.recurrence.freq}` as "taskCenter.todo.repeat.daily")}
        </span>
      ),
    });
  }
  if (task.remindAt != null) {
    meta.push({
      key: "remind",
      node: (
        <span className="user-todo-row__meta-item">
          <IconBell size={12} />
          {formatRemindFull(task.remindAt, locale, t)}
        </span>
      ),
    });
  }
  const note = (task.note ?? "").trim();
  if (note && meta.length === 0) {
    meta.push({
      key: "note",
      node: (
        <span className="user-todo-row__meta-item user-todo-row__meta-item--note">
          {note.split("\n")[0]}
        </span>
      ),
    });
  }

  return (
    <div
      className={`user-todo-row${active ? " is-active" : ""}${task.completed ? " is-done" : ""}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <button
        type="button"
        className={`user-todo-check${task.completed ? " is-done" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggleComplete();
        }}
      >
        {task.completed ? <IconCheckCircle size={16} /> : <span className="user-todo-check__ring" />}
      </button>
      <div className="user-todo-row__body">
        <div className="user-todo-row__title">{task.title}</div>
        {meta.length > 0 && (
          <div className="user-todo-row__meta">
            {meta.map((item, i) => (
              <Fragment key={item.key}>
                {i > 0 && <span className="user-todo-row__meta-sep" aria-hidden>•</span>}
                {item.node}
              </Fragment>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        className={`user-todo-star${task.important ? " is-on" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggleImportant();
        }}
      >
        ★
      </button>
    </div>
  );
}

function StepComposer({
  placeholder,
  onAdd,
}: {
  placeholder: string;
  onAdd: (title: string) => void;
}) {
  const [text, setText] = useState("");
  return (
    <div className="user-todo-step-composer">
      <IconPlus size={14} />
      <input
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onAdd(text);
            setText("");
          }
        }}
      />
    </div>
  );
}

// helpers re-exported for menus via userTodoStore

