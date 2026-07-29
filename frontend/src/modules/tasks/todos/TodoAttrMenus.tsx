import { useEffect, useRef, useState, type ReactNode } from "react";
import { IconBell, IconClock, IconClose, IconRefresh } from "../../../components/ui/icons/Icons";
import { useI18n } from "../../../i18n";
import type { TodoTask } from "../../../ipc/bindings";
import { addDaysLocal, localYmd, startOfLocalDay } from "../../../stores/userTodoStore";

function atHour(base: Date, hour: number): number {
  const d = new Date(base);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

function laterToday(): number {
  const now = new Date();
  const candidate = atHour(now, 13);
  if (candidate > Date.now()) return candidate;
  const evening = atHour(now, 18);
  if (evening > Date.now()) return evening;
  return addDaysLocal(now, 1).setHours(9, 0, 0, 0);
}

function tomorrowNine(): number {
  return atHour(addDaysLocal(new Date(), 1), 9);
}

function nextMondayNine(): number {
  const d = new Date();
  const day = d.getDay(); // 0 Sun
  const add = day === 0 ? 1 : day === 1 ? 7 : 8 - day;
  return atHour(addDaysLocal(d, add), 9);
}

function formatShort(ts: number, locale: string): string {
  return new Date(ts).toLocaleString(locale === "zh-CN" ? "zh-CN" : "en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function weekdayShort(d: Date, locale: string): string {
  return d.toLocaleDateString(locale === "zh-CN" ? "zh-CN" : "en-US", { weekday: "short" });
}

/** 截止日期快捷菜单内容（详情栏 / 底栏共用） */
export function DueDateMenu({
  onPick,
  close,
}: {
  onPick: (ts: number) => void;
  close: () => void;
}) {
  const { t, locale } = useI18n();
  return (
    <div className="user-todo-menu">
      <MenuItem
        label={t("taskCenter.todo.today")}
        detail={weekdayShort(new Date(), locale)}
        onClick={() => {
          onPick(startOfLocalDay());
          close();
        }}
      />
      <MenuItem
        label={t("taskCenter.todo.tomorrow")}
        detail={weekdayShort(addDaysLocal(new Date(), 1), locale)}
        onClick={() => {
          onPick(startOfLocalDay(addDaysLocal(new Date(), 1)));
          close();
        }}
      />
      <MenuItem
        label={t("taskCenter.todo.nextWeek")}
        detail={weekdayShort(new Date(nextMondayNine()), locale)}
        onClick={() => {
          onPick(startOfLocalDay(new Date(nextMondayNine())));
          close();
        }}
      />
      <div className="user-todo-menu__sep" />
      <label className="user-todo-menu__pick">
        <span>{t("taskCenter.todo.pickDate")}</span>
        <input
          type="date"
          onChange={(e) => {
            const v = e.target.value;
            if (!v) return;
            onPick(startOfLocalDay(new Date(v + "T00:00:00")));
            close();
          }}
        />
      </label>
    </div>
  );
}

/** 提醒快捷菜单内容 */
export function RemindMenu({
  onPick,
  close,
}: {
  onPick: (ts: number) => void;
  close: () => void;
}) {
  const { t, locale } = useI18n();
  return (
    <div className="user-todo-menu">
      <MenuItem
        label={t("taskCenter.todo.laterToday")}
        detail="13:00"
        onClick={() => {
          onPick(laterToday());
          close();
        }}
      />
      <MenuItem
        label={t("taskCenter.todo.tomorrow")}
        detail={weekdayShort(addDaysLocal(new Date(), 1), locale) + ", 9:00"}
        onClick={() => {
          onPick(tomorrowNine());
          close();
        }}
      />
      <MenuItem
        label={t("taskCenter.todo.nextWeek")}
        detail={weekdayShort(new Date(nextMondayNine()), locale) + ", 9:00"}
        onClick={() => {
          onPick(nextMondayNine());
          close();
        }}
      />
      <div className="user-todo-menu__sep" />
      <label className="user-todo-menu__pick">
        <span>{t("taskCenter.todo.pickDateTime")}</span>
        <input
          type="datetime-local"
          onChange={(e) => {
            const v = e.target.value;
            if (!v) return;
            onPick(new Date(v).getTime());
            close();
          }}
        />
      </label>
    </div>
  );
}

/** 重复快捷菜单内容 */
export function RepeatMenu({
  onPick,
  close,
}: {
  onPick: (freq: string) => void;
  close: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="user-todo-menu">
      {(["daily", "weekdays", "weekly", "monthly", "yearly"] as const).map((freq) => (
        <MenuItem
          key={freq}
          label={t(`taskCenter.todo.repeat.${freq}`)}
          onClick={() => {
            onPick(freq);
            close();
          }}
        />
      ))}
    </div>
  );
}

/** 底栏图标触发的小型 popover（菜单向上展开，fixed 避免被裁切） */
export function ComposerIconPopover({
  active,
  title,
  icon,
  children,
}: {
  active?: boolean;
  title: string;
  icon: ReactNode;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ right: number; bottom: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  useEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    setPos({
      right: window.innerWidth - rect.right,
      bottom: window.innerHeight - rect.top + 8,
    });
  }, [open]);

  return (
    <div className="user-todo-composer-pop" ref={ref}>
      <button
        ref={btnRef}
        type="button"
        className={`user-todo-composer__icon-btn${active ? " is-on" : ""}${open ? " is-open" : ""}`}
        title={title}
        aria-label={title}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {icon}
      </button>
      {open && pos && (
        <div
          className="user-todo-menu-pop user-todo-menu-pop--fixed-up"
          style={{ right: pos.right, bottom: pos.bottom }}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function TodoAttrMenus({
  task,
  onToggleMyDay,
  onSetDue,
  onClearDue,
  onSetRemind,
  onClearRemind,
  onSetRecurrence,
  onClearRecurrence,
}: {
  task: TodoTask;
  onToggleMyDay: () => void;
  onSetDue: (ts: number) => void;
  onClearDue: () => void;
  onSetRemind: (ts: number) => void;
  onClearRemind: () => void;
  onSetRecurrence: (freq: string) => void;
  onClearRecurrence: () => void;
}) {
  const { t, locale } = useI18n();
  const today = localYmd();
  const inMyDay = task.myDayOn === today;

  return (
    <div className="user-todo-attrs">
      <button
        type="button"
        className={`user-todo-attr${inMyDay ? " is-set" : ""}`}
        onClick={onToggleMyDay}
      >
        <IconClock size={14} />
        <span>{inMyDay ? t("taskCenter.todo.addedToMyDay") : t("taskCenter.todo.addToMyDay")}</span>
        {inMyDay && (
          <span
            className="user-todo-attr__clear"
            onClick={(e) => {
              e.stopPropagation();
              onToggleMyDay();
            }}
          >
            <IconClose size={12} />
          </span>
        )}
      </button>

      <PopoverRow
        icon={<IconBell size={14} />}
        label={
          task.remindAt
            ? t("taskCenter.todo.remindAt", { time: formatShort(task.remindAt, locale) })
            : t("taskCenter.todo.remindMe")
        }
        set={!!task.remindAt}
        onClear={onClearRemind}
      >
        {(close) => <RemindMenu onPick={onSetRemind} close={close} />}
      </PopoverRow>

      <PopoverRow
        icon={<IconClock size={14} />}
        label={
          task.dueAt
            ? t("taskCenter.todo.dueOn", {
                date: new Date(task.dueAt).toLocaleDateString(
                  locale === "zh-CN" ? "zh-CN" : "en-US",
                  { month: "short", day: "numeric", weekday: "short" },
                ),
              })
            : t("taskCenter.todo.addDue")
        }
        set={task.dueAt != null}
        onClear={onClearDue}
      >
        {(close) => <DueDateMenu onPick={onSetDue} close={close} />}
      </PopoverRow>

      <PopoverRow
        icon={<IconRefresh size={14} />}
        label={
          task.recurrence
            ? t(`taskCenter.todo.repeat.${task.recurrence.freq}` as "taskCenter.todo.repeat.daily")
            : t("taskCenter.todo.repeat.label")
        }
        set={!!task.recurrence}
        onClear={onClearRecurrence}
      >
        {(close) => <RepeatMenu onPick={onSetRecurrence} close={close} />}
      </PopoverRow>
    </div>
  );
}

function PopoverRow({
  icon,
  label,
  set,
  onClear,
  children,
}: {
  icon: ReactNode;
  label: string;
  set: boolean;
  onClear: () => void;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="user-todo-attr-wrap" ref={ref}>
      <button
        type="button"
        className={`user-todo-attr${set ? " is-set" : ""}`}
        onClick={() => setOpen((v) => !v)}
      >
        {icon}
        <span>{label}</span>
        {set && (
          <span
            className="user-todo-attr__clear"
            onClick={(e) => {
              e.stopPropagation();
              onClear();
            }}
          >
            <IconClose size={12} />
          </span>
        )}
      </button>
      {open && <div className="user-todo-menu-pop">{children(() => setOpen(false))}</div>}
    </div>
  );
}

function MenuItem({
  label,
  detail,
  onClick,
}: {
  label: string;
  detail?: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="user-todo-menu__item" onClick={onClick}>
      <span>{label}</span>
      {detail && <span className="user-todo-menu__detail">{detail}</span>}
    </button>
  );
}
