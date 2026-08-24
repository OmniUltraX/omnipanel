import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import type { TeamSyncPeekItem, TeamSyncPeekModule, TeamSyncPeekResult } from "../../ipc/bindings";
import {
  clearTeamSyncExcluded,
  markTeamSyncExcluded,
  type TeamSyncModuleKey,
} from "../../modules/teamSync/exclusions";
import { showToast } from "../../stores/toastStore";
import { IconChevronDown, IconFolder, IconLink, IconXCircle } from "../ui/icons/Icons";

type PeekItem = TeamSyncPeekItem & { moduleKey: TeamSyncModuleKey };

type TreeNode = {
  item: PeekItem;
  children: TreeNode[];
};

function isFolder(item: TeamSyncPeekItem): boolean {
  return item.kind === "folder";
}

function isVirtualNode(item: TeamSyncPeekItem): boolean {
  return item.id.startsWith("__module__:") || item.id.startsWith("__group__:");
}

function isSyncManageable(item: PeekItem): boolean {
  if (item.syncStatus === "remote") return false;
  if (item.id.startsWith("__module__:") || item.id.startsWith("__group__:")) return false;
  if (item.detail === "layout-folder") return false;
  if (item.kind === "folder" && item.moduleKey !== "http" && item.moduleKey !== "knowledge") {
    return false;
  }
  return true;
}

function normalizeParentId(parentId: string | null | undefined): string {
  return parentId?.trim() ?? "";
}

function moduleKeyFromId(id: string): string | null {
  if (!id.startsWith("__module__:")) return null;
  return id.slice("__module__:".length);
}

function buildTree(items: PeekItem[]): TreeNode[] {
  const byParent = new Map<string, PeekItem[]>();
  for (const item of items) {
    const parent = normalizeParentId(item.parentId);
    const list = byParent.get(parent) ?? [];
    list.push(item);
    byParent.set(parent, list);
  }

  const sortItems = (list: PeekItem[]) =>
    [...list].sort((a, b) => {
      const folderFirst = Number(isFolder(b)) - Number(isFolder(a));
      if (folderFirst !== 0) return folderFirst;
      return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
    });

  const ids = new Set(items.map((i) => i.id));

  const build = (parentId: string): TreeNode[] =>
    sortItems(byParent.get(parentId) ?? []).map((item) => ({
      item,
      children: isFolder(item) ? build(item.id) : [],
    }));

  const moduleRoots = sortItems(byParent.get("") ?? []).filter((item) =>
    item.id.startsWith("__module__:"),
  );
  if (moduleRoots.length > 0) {
    return moduleRoots.map((item) => ({
      item,
      children: build(item.id),
    }));
  }

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

function collectSyncTargets(node: TreeNode): PeekItem[] {
  const targets: PeekItem[] = [];
  // 无 id 的条目无法参与团队同步排除，直接跳过
  if (isSyncManageable(node.item) && typeof node.item.id === "string") {
    targets.push(node.item);
  }
  for (const child of node.children) {
    targets.push(...collectSyncTargets(child));
  }
  return targets;
}

function nodeSyncState(node: TreeNode): {
  hasTargets: boolean;
  allExcluded: boolean;
} {
  const targets = collectSyncTargets(node);
  if (targets.length === 0) {
    return { hasTargets: false, allExcluded: false };
  }
  return {
    hasTargets: true,
    allExcluded: targets.every((item) => item.excluded),
  };
}

function formatUpdatedAt(value: number | null | undefined, locale: string): string {
  if (!value || value <= 0) return "—";
  const ms = value < 1e12 ? value * 1000 : value;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(locale);
}

function resolveSyncStatusBadge(
  item: TeamSyncPeekItem,
  t: (key: string) => string,
): { className: string; label: string } | null {
  switch (item.syncStatus) {
    case "synced":
      return {
        className: "user-center-team-data__sync-status user-center-team-data__sync-status--synced",
        label: t("userCenter.teams.syncedBadge"),
      };
    case "local":
      return {
        className: "user-center-team-data__sync-status user-center-team-data__sync-status--local",
        label: t("userCenter.teams.localOnlyBadge"),
      };
    case "remote":
      return {
        className: "user-center-team-data__sync-status user-center-team-data__sync-status--remote",
        label: t("userCenter.teams.remoteOnlyBadge"),
      };
    default:
      return null;
  }
}

function resolveLabel(item: TeamSyncPeekItem, t: (key: string) => string): string {
  const moduleKey = moduleKeyFromId(item.id);
  if (moduleKey) {
    return t(`userCenter.teams.dataModules.${moduleKey}`);
  }
  return item.label;
}

function flattenModules(modules: TeamSyncPeekModule[]): PeekItem[] {
  return modules.flatMap((module) =>
    module.items.map((item) => ({
      ...item,
      moduleKey: module.key as TeamSyncModuleKey,
    })),
  );
}

export function TeamDataTree({
  teamId,
  peek,
  loading,
  error,
  onExclusionChange,
}: {
  teamId: number;
  peek: TeamSyncPeekResult | null;
  loading: boolean;
  error: string | null;
  onExclusionChange: () => void;
}) {
  const { t, locale } = useI18n();
  const items = useMemo(() => (peek ? flattenModules(peek.modules) : []), [peek]);
  const tree = useMemo(() => buildTree(items), [items]);
  const treeStructureKey = useMemo(
    () => items.map((item) => `${item.id}|${normalizeParentId(item.parentId)}`).join(";"),
    [items],
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setCollapsed(new Set());
  }, [treeStructureKey]);

  const rows = useMemo(() => flattenVisible(tree, collapsed), [tree, collapsed]);

  const toggleCollapsed = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const applySubtreeExclusion = (node: TreeNode, excluded: boolean) => {
    const targets = collectSyncTargets(node);
    for (const target of targets) {
      if (excluded) {
        markTeamSyncExcluded(teamId, target.moduleKey, target.id as string, target.kind as string);
      } else {
        clearTeamSyncExcluded(teamId, target.moduleKey, target.id as string, target.kind as string);
      }
    }
    showToast(
      t(excluded ? "userCenter.teams.cancelSyncSuccess" : "userCenter.teams.restoreSyncSuccess"),
    );
    onExclusionChange();
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
      <div className="data-sync-table-wrap user-center-team-data__table-wrap">
        <table className="data-sync-table user-center-team-data__table">
          <thead>
            <tr>
              <th>{t("userCenter.teams.dataPreviewColumnName")}</th>
              <th>{t("userCenter.teams.dataPreviewColumnTags")}</th>
              <th className="data-sync-table__time">{t("userCenter.teams.dataPreviewColumnUpdated")}</th>
              <th className="user-center-team-data__actions-col">
                {t("userCenter.teams.dataPreviewColumnActions")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ node, depth }) => {
              const { item, children } = node;
              const hasChildren = children.length > 0;
              const folder = isFolder(item);
              const isCollapsed = collapsed.has(item.id);
              const label = resolveLabel(item, t);
              const syncState = nodeSyncState(node);
              const syncStatusBadge = resolveSyncStatusBadge(item, t);
              const showExcludedBadge =
                item.excluded || (isVirtualNode(item) && syncState.allExcluded && syncState.hasTargets);

              return (
                <tr key={item.id} className={folder ? "is-folder" : ""}>
                  <td className="data-sync-table__name">
                    <div className="data-sync-tree-cell" style={{ paddingLeft: depth * 14 }}>
                      {hasChildren ? (
                        <button
                          type="button"
                          className={`data-sync-tree-toggle${isCollapsed ? "" : " is-open"}`}
                          aria-expanded={!isCollapsed}
                          onClick={() => toggleCollapsed(item.id)}
                        >
                          <IconChevronDown size={11} />
                        </button>
                      ) : (
                        <span className="data-sync-tree-toggle-spacer" />
                      )}
                      {folder ? <IconFolder size={12} className="data-sync-tree-folder-icon" /> : null}
                      <span>{label}</span>
                      {syncStatusBadge ? (
                        <span className={syncStatusBadge.className}>{syncStatusBadge.label}</span>
                      ) : null}
                      {showExcludedBadge ? (
                        <span className="user-center-team-data__excluded">
                          {t("userCenter.teams.excludedBadge")}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="data-sync-table__tags">
                    {item.tags && item.tags.length > 0 ? (
                      <div className="data-sync-table__tag-list">
                        {item.tags.map((tag) => (
                          <span key={tag} className="data-sync-table__tag" title={tag}>
                            {tag}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="data-sync-table__tags-empty">—</span>
                    )}
                  </td>
                  <td className="data-sync-table__time">{formatUpdatedAt(item.updatedAt, locale)}</td>
                  <td className="user-center-team-data__actions-col">
                    {syncState.hasTargets ? (
                      syncState.allExcluded ? (
                        <button
                          type="button"
                          className="btn-icon user-center-team-data__action-btn"
                          title={t("userCenter.teams.restoreSync")}
                          aria-label={t("userCenter.teams.restoreSync")}
                          onClick={() => applySubtreeExclusion(node, false)}
                        >
                          <IconLink size={14} />
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn-icon user-center-team-data__action-btn user-center-team-data__action-btn--danger"
                          title={t("userCenter.teams.cancelSync")}
                          aria-label={t("userCenter.teams.cancelSync")}
                          onClick={() => applySubtreeExclusion(node, true)}
                        >
                          <IconXCircle size={14} />
                        </button>
                      )
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
