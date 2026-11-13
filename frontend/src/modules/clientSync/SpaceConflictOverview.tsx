import { useEffect, useMemo, useRef, useState } from "react";
import { FormDialog } from "../../components/ui/FormDialog";
import { WorkbenchActionButton } from "../../components/ui/primitives/WorkbenchActionButton";
import { formatIpcError } from "../../ipc/result";
import { useI18n } from "../../i18n";
import { useConnectionStore } from "../../stores/connectionStore";
import { useSpaceConflictStore } from "../../stores/spaceConflictStore";
import type { SpaceConflict } from "../../ipc/bindings";
import { SpaceConflictCompare } from "./SpaceConflictCompare";

const KIND_PREFIX: Array<[string, string]> = [
  ["connections/", "connection"],
  ["sshkeys/", "sshKey"],
  ["databases/", "database"],
  ["accounts/", "account"],
  ["http/requests/", "http"],
  ["http/collections/", "httpCollection"],
  ["http/environments/", "httpEnvironment"],
  ["knowledge/", "knowledge"],
  ["workflows/", "workflow"],
  ["plugins/", "plugin"],
  ["skills/", "skill"],
  ["conversations/", "conversation"],
  ["todos/", "todo"],
  ["settings/", "settings"],
  ["tree/", "tree"],
  ["panels/", "panels"],
  ["workspaces/", "workspace"],
];

const KIND_ORDER = KIND_PREFIX.map(([, key]) => key).concat("other");

const KIND_COLOR: Record<string, string> = {
  connection: "var(--accent)",
  sshKey: "var(--warn)",
  database: "var(--success)",
  account: "color-mix(in srgb, var(--warn) 70%, var(--danger))",
  http: "color-mix(in srgb, var(--accent) 65%, var(--success))",
  httpCollection: "color-mix(in srgb, var(--accent) 40%, var(--success))",
  httpEnvironment: "color-mix(in srgb, var(--success) 55%, var(--accent))",
  knowledge: "color-mix(in srgb, var(--success) 75%, var(--accent))",
  workflow: "color-mix(in srgb, var(--accent) 50%, var(--warn))",
  plugin: "color-mix(in srgb, var(--danger) 40%, var(--accent))",
  skill: "color-mix(in srgb, var(--success) 55%, var(--warn))",
  conversation: "color-mix(in srgb, var(--accent) 80%, var(--meta))",
  todo: "var(--danger)",
  settings: "var(--meta)",
  tree: "color-mix(in srgb, var(--meta) 40%, var(--accent))",
  panels: "color-mix(in srgb, var(--warn) 45%, var(--accent))",
  workspace: "color-mix(in srgb, var(--accent) 35%, var(--fg))",
  other: "var(--meta)",
};

type ConflictGroup = {
  key: string;
  labelKey: string;
  labelText?: string;
  color: string;
  items: SpaceConflict[];
};

function fileLabel(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.json$/i, "");
}

function groupOf(path: string): { key: string; labelKey: string; labelText?: string } {
  for (const [prefix, key] of KIND_PREFIX) {
    if (path.startsWith(prefix)) return { key, labelKey: key };
  }
  const head = path.includes("/") ? path.slice(0, path.indexOf("/")) : "";
  if (head) return { key: `dir:${head}`, labelKey: "other", labelText: head };
  return { key: "other", labelKey: "other" };
}

function formatWhen(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const date = new Date(ts);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function TriCheck({
  checked,
  indeterminate,
  label,
  disabled,
  onChange,
}: {
  checked: boolean;
  indeterminate?: boolean;
  label: string;
  disabled?: boolean;
  onChange: (shift: boolean) => void;
}) {
  const shift = useRef(false);
  return (
    <input
      type="checkbox"
      className="space-conflict-tree__check"
      checked={checked}
      disabled={disabled}
      aria-label={label}
      ref={(node) => {
        if (node) node.indeterminate = Boolean(indeterminate && !checked);
      }}
      onMouseDown={(event) => {
        shift.current = event.shiftKey;
      }}
      onClick={(event) => event.stopPropagation()}
      onChange={() => onChange(shift.current)}
    />
  );
}

/** 按资源类型收成树。多选和分组都只清冲突标记，不改当前资源。 */
export function SpaceConflictOverview() {
  const { t } = useI18n();
  const items = useSpaceConflictStore((s) => s.items);
  const closeOverview = useSpaceConflictStore((s) => s.closeOverview);
  const dismissIds = useSpaceConflictStore((s) => s.dismissIds);
  const connections = useConnectionStore((s) => s.connections);
  const [compareId, setCompareId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [anchor, setAnchor] = useState<string | null>(null);

  const names = useMemo(
    () => new Map(connections.map((item) => [item.id, item.name])),
    [connections],
  );

  const groups = useMemo(() => {
    const buckets = new Map<string, ConflictGroup>();
    for (const item of items) {
      const group = groupOf(item.path);
      const existing = buckets.get(group.key);
      if (existing) {
        existing.items.push(item);
        continue;
      }
      buckets.set(group.key, {
        key: group.key,
        labelKey: group.labelKey,
        labelText: group.labelText,
        color: KIND_COLOR[group.labelKey] ?? KIND_COLOR.other,
        items: [item],
      });
    }
    return [...buckets.values()].sort((a, b) => {
      const ai = KIND_ORDER.indexOf(a.labelKey);
      const bi = KIND_ORDER.indexOf(b.labelKey);
      const order = (ai === -1 ? KIND_ORDER.length : ai) - (bi === -1 ? KIND_ORDER.length : bi);
      if (order !== 0) return order;
      return (a.labelText ?? a.key).localeCompare(b.labelText ?? b.key);
    });
  }, [items]);

  const visibleIds = useMemo(
    () =>
      groups.flatMap((group) =>
        collapsed.has(group.key) ? [] : group.items.map((item) => item.id),
      ),
    [collapsed, groups],
  );

  useEffect(() => {
    const live = new Set(items.map((item) => item.id));
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [items]);

  const allChecked = items.length > 0 && selected.size === items.length;
  const someChecked = selected.size > 0 && !allChecked;

  const runDismiss = (ids: string[]) => {
    if (busy || ids.length === 0) return;
    setBusy(true);
    setError(null);
    void dismissIds(ids)
      .then(() => {
        if (useSpaceConflictStore.getState().overviewOpen) setBusy(false);
      })
      .catch((err: unknown) => {
        setError(formatIpcError(err));
        setBusy(false);
      });
  };

  const toggleOne = (id: string, shift: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (shift && anchor) {
        const from = visibleIds.indexOf(anchor);
        const to = visibleIds.indexOf(id);
        if (from >= 0 && to >= 0) {
          const [lo, hi] = from < to ? [from, to] : [to, from];
          for (const itemId of visibleIds.slice(lo, hi + 1)) next.add(itemId);
          return next;
        }
      }
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setAnchor(id);
  };

  const toggleGroup = (group: ConflictGroup) => {
    const ids = group.items.map((item) => item.id);
    const all = ids.every((id) => selected.has(id));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (all) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(allChecked ? new Set() : new Set(items.map((item) => item.id)));
  };

  return (
    <>
      <FormDialog
        open
        onClose={closeOverview}
        title={t("app.conflict.overviewTitle")}
        size="lg"
        cancelLabel={t("common.close")}
        status={error ? { kind: "error", message: error } : null}
        actions={[
          {
            key: "keepSelected",
            label: t("app.conflict.keepSelected"),
            disabled: busy || selected.size === 0,
            onClick: () => runDismiss([...selected]),
          },
          {
            key: "keepAll",
            label: t("app.conflict.keepAll"),
            disabled: busy || items.length === 0,
            onClick: () => runDismiss(items.map((item) => item.id)),
          },
        ]}
      >
        <p className="space-conflict-overview__lead">{t("app.conflict.overviewLead")}</p>
        <div className="space-conflict-tree__toolbar">
          <label className="space-conflict-tree__select-all">
            <TriCheck
              checked={allChecked}
              indeterminate={someChecked}
              disabled={busy || items.length === 0}
              label={t("app.conflict.selectAll")}
              onChange={toggleAll}
            />
            <span>{t("app.conflict.selectAll")}</span>
          </label>
          <span className="space-conflict-tree__selected">
            {t("app.conflict.selected", { count: selected.size, total: items.length })}
          </span>
        </div>
        <div className="space-conflict-tree">
          {groups.map((group) => {
            const ids = group.items.map((item) => item.id);
            const groupAll = ids.every((id) => selected.has(id));
            const groupSome = !groupAll && ids.some((id) => selected.has(id));
            const open = !collapsed.has(group.key);
            const label = group.labelText ?? t(`app.conflict.kind.${group.labelKey}`);
            return (
              <section
                key={group.key}
                className="space-conflict-tree__group"
                style={{ ["--kind" as string]: group.color }}
              >
                <div className="space-conflict-tree__head">
                  <button
                    type="button"
                    className={`space-conflict-tree__chevron${open ? " is-open" : ""}`}
                    aria-label={open ? t("app.conflict.collapse") : t("app.conflict.expand")}
                    aria-expanded={open}
                    onClick={() =>
                      setCollapsed((prev) => {
                        const next = new Set(prev);
                        if (next.has(group.key)) next.delete(group.key);
                        else next.add(group.key);
                        return next;
                      })
                    }
                  >
                    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
                      <path d="M4 2.5 8 6 4 9.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
                    </svg>
                  </button>
                  <TriCheck
                    checked={groupAll}
                    indeterminate={groupSome}
                    disabled={busy}
                    label={label}
                    onChange={() => toggleGroup(group)}
                  />
                  <span className="space-conflict-tree__dot" aria-hidden />
                  <span className="space-conflict-tree__kind">{label}</span>
                  <span className="space-conflict-tree__count">{group.items.length}</span>
                  <span className="space-conflict-tree__spacer" />
                  <WorkbenchActionButton
                    disabled={busy}
                    onClick={() => runDismiss(ids)}
                  >
                    {t("app.conflict.keepGroup")}
                  </WorkbenchActionButton>
                </div>
                {open ? (
                  <ul className="space-conflict-tree__items">
                    {group.items.map((item) => {
                      const id = fileLabel(item.path);
                      const name = item.path.startsWith("connections/") ? (names.get(id) ?? id) : id;
                      const on = selected.has(item.id);
                      return (
                        <li
                          key={item.id}
                          className={`space-conflict-tree__item${on ? " is-selected" : ""}`}
                        >
                          <TriCheck
                            checked={on}
                            disabled={busy}
                            label={name}
                            onChange={(shift) => toggleOne(item.id, shift)}
                          />
                          <button
                            type="button"
                            className="space-conflict-tree__name"
                            title={item.path}
                            onClick={() => setCompareId(item.id)}
                          >
                            {name}
                          </button>
                          <span className="space-conflict-tree__path" title={item.path}>
                            {item.path}
                          </span>
                          {item.recordedAt > 0 ? (
                            <time
                              className="space-conflict-tree__time"
                              dateTime={new Date(item.recordedAt).toISOString()}
                            >
                              {formatWhen(item.recordedAt)}
                            </time>
                          ) : (
                            <span className="space-conflict-tree__time" />
                          )}
                          <WorkbenchActionButton disabled={busy} onClick={() => setCompareId(item.id)}>
                            {t("app.conflict.openCompare")}
                          </WorkbenchActionButton>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </section>
            );
          })}
        </div>
      </FormDialog>
      {compareId ? (
        <SpaceConflictCompare id={compareId} onClose={() => setCompareId(null)} />
      ) : null}
    </>
  );
}
