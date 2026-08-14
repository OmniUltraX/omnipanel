import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import type { TeamSyncPeekItem, TeamSyncPeekModule, TeamSyncPeekResult } from "../../ipc/bindings";
import { IconChevronDown, IconFolder } from "../ui/icons/Icons";

type TreeNode = {
  item: TeamSyncPeekItem;
  children: TreeNode[];
};

function isFolder(item: TeamSyncPeekItem): boolean {
  return item.kind === "folder";
}

function normalizeParentId(parentId: string | null | undefined): string {
  return parentId?.trim() ?? "";
}

function moduleKeyFromId(id: string): string | null {
  if (!id.startsWith("__module__:")) return null;
  return id.slice("__module__:".length);
}

function buildTree(items: TeamSyncPeekItem[]): TreeNode[] {
  const byParent = new Map<string, TeamSyncPeekItem[]>();
  for (const item of items) {
    const parent = normalizeParentId(item.parentId);
    const list = byParent.get(parent) ?? [];
    list.push(item);
    byParent.set(parent, list);
  }

  const sortItems = (list: TeamSyncPeekItem[]) =>
    [...list].sort((a, b) => {
      const folderFirst = Number(isFolder(b)) - Number(isFolder(a));
      if (folderFirst !== 0) return folderFirst;
      return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
    });

  const build = (parentId: string): TreeNode[] =>
    sortItems(byParent.get(parentId) ?? []).map((item) => ({
      item,
      children: isFolder(item) ? build(item.id) : [],
    }));

  const ids = new Set(items.map((i) => i.id));
  const roots = build("");
  const orphanParents = [...byParent.keys()].filter((p) => p && !ids.has(p));
  for (const parent of orphanParents) {
    roots.push(...build(parent));
  }
  return roots;
}

function flattenVisible(
  nodes: TreeNode[],
  collapsed: Set<string>,
  depth = 0,
): Array<{ node: TreeNode; depth: number }> {
  const rows: Array<{ node: TreeNode; depth: number }> = [];
  for (const node of nodes) {
    rows.push({ node, depth });
    if (node.children.length > 0 && !collapsed.has(node.item.id)) {
      rows.push(...flattenVisible(node.children, collapsed, depth + 1));
    }
  }
  return rows;
}

function formatUpdatedAt(value: number, locale: string): string {
  if (!value || value <= 0) return "—";
  const ms = value < 1e12 ? value * 1000 : value;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(locale);
}

function resolveLabel(item: TeamSyncPeekItem, t: (key: string) => string): string {
  const moduleKey = moduleKeyFromId(item.id);
  if (moduleKey) {
    return t(`userCenter.teams.dataModules.${moduleKey}`);
  }
  return item.label;
}

function flattenModules(modules: TeamSyncPeekModule[]): TeamSyncPeekItem[] {
  return modules.flatMap((module) => module.items);
}

export function TeamDataTree({
  peek,
  loading,
  error,
}: {
  peek: TeamSyncPeekResult | null;
  loading: boolean;
  error: string | null;
}) {
  const { t, locale } = useI18n();
  const items = useMemo(() => (peek ? flattenModules(peek.modules) : []), [peek]);
  const tree = useMemo(() => buildTree(items), [items]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setCollapsed(new Set());
  }, [items]);

  const rows = useMemo(() => flattenVisible(tree, collapsed), [tree, collapsed]);

  const toggleCollapsed = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (loading) {
    return <p className="user-center-devices__hint">{t("userCenter.teams.dataPreviewLoading")}</p>;
  }
  if (error) {
    return <p className="user-center-devices__error">{error}</p>;
  }
  if (!peek || items.length === 0) {
    return <p className="user-center-devices__group-empty">{t("userCenter.teams.dataPreviewEmpty")}</p>;
  }

  return (
    <div className="user-center-team-data">
      <p className="user-center-team-data__meta">
        {peek.remoteFound
          ? t("userCenter.teams.dataPreviewRemoteFound", {
              time: formatUpdatedAt(peek.remoteUpdatedAt, locale),
            })
          : t("userCenter.teams.dataPreviewRemoteMissing")}
      </p>
      <div className="data-sync-table-wrap">
        <table className="data-sync-table">
          <thead>
            <tr>
              <th>{t("userCenter.teams.dataPreviewColumnName")}</th>
              <th>{t("userCenter.teams.dataPreviewColumnDetail")}</th>
              <th className="data-sync-table__time">{t("userCenter.teams.dataPreviewColumnUpdated")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ node, depth }) => {
              const { item, children } = node;
              const hasChildren = children.length > 0;
              const folder = isFolder(item);
              const isCollapsed = collapsed.has(item.id);
              const label = resolveLabel(item, t);

              return (
                <tr key={item.id} className={folder ? "is-folder" : ""}>
                  <td className="data-sync-table__name">
                    <div className="data-sync-tree-cell" style={{ paddingLeft: depth * 16 }}>
                      {hasChildren ? (
                        <button
                          type="button"
                          className={`data-sync-tree-toggle${isCollapsed ? "" : " is-open"}`}
                          aria-expanded={!isCollapsed}
                          onClick={() => toggleCollapsed(item.id)}
                        >
                          <IconChevronDown size={12} />
                        </button>
                      ) : (
                        <span className="data-sync-tree-toggle-spacer" />
                      )}
                      {folder ? <IconFolder size={13} className="data-sync-tree-folder-icon" /> : null}
                      <span>{label}</span>
                      {item.synced ? (
                        <span className="user-center-team-data__synced">{t("userCenter.teams.syncedBadge")}</span>
                      ) : null}
                    </div>
                  </td>
                  <td className="data-sync-table__detail">{item.detail || "—"}</td>
                  <td className="data-sync-table__time">{formatUpdatedAt(item.updatedAt, locale)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
