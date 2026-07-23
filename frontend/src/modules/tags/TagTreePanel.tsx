import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useI18n } from "../../i18n";
import { commands, type TagDto } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { quickInput } from "../../lib/quickInput";
import { appConfirm } from "../../lib/appConfirm";
import { buildTagTree, useTagStore, type TagTreeNode } from "./tagStore";
import type { ModuleTagFilterScope } from "./moduleTagScope";

const EMPTY_TAG_LIST: TagDto[] = [];

interface TagTreePanelProps {
  selectedIds: string[];
  onToggle: (id: string) => void;
  matchMode: "and" | "or";
  onMatchModeChange: (mode: "and" | "or") => void;
  className?: string;
  /**
   * 筛选作用域：传入时只展示该范围内资源已用过的标签；
   * 且隐藏创建/删除（打标请走资源编辑器，全局可选）。
   */
  filterScope?: ModuleTagFilterScope | null;
}

export function TagTreePanel({
  selectedIds,
  onToggle,
  matchMode,
  onMatchModeChange,
  className,
  filterScope = null,
}: TagTreePanelProps) {
  const { t } = useI18n();
  const scoped = filterScope != null;
  const globalTags = useTagStore((s) => (scoped ? EMPTY_TAG_LIST : s.tags));
  const refresh = useTagStore((s) => s.refresh);
  const loaded = useTagStore((s) => s.loaded);
  const [scopedTags, setScopedTags] = useState<TagDto[] | null>(null);
  const [scopedLoading, setScopedLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (scoped) return;
    if (!loaded) void refresh();
  }, [scoped, loaded, refresh]);

  useEffect(() => {
    if (!scoped || !filterScope) {
      setScopedTags(null);
      return;
    }
    let cancelled = false;
    setScopedLoading(true);
    void unwrapCommand(
      commands.tagListUsedBy(
        true,
        filterScope.resourceKinds ?? null,
        filterScope.connectionKinds ?? null,
        filterScope.extraResourceIds ?? null,
        true,
      ),
    )
      .then((list) => {
        if (!cancelled) setScopedTags(list);
      })
      .catch(() => {
        if (!cancelled) setScopedTags([]);
      })
      .finally(() => {
        if (!cancelled) setScopedLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    scoped,
    filterScope?.resourceKinds?.join("\0"),
    filterScope?.connectionKinds?.join("\0"),
    filterScope?.extraResourceIds?.join("\0"),
  ]);

  const tags = scoped ? (scopedTags ?? []) : globalTags;
  const tree = useMemo(() => buildTagTree(tags), [tags]);

  const filterLower = filter.trim().toLowerCase();
  const visibleTree = useMemo(() => {
    if (!filterLower) return tree;
    const filterNode = (node: TagTreeNode): TagTreeNode | null => {
      const kids = node.children
        .map(filterNode)
        .filter((n): n is TagTreeNode => n != null);
      const selfHit = node.tag.path.toLowerCase().includes(filterLower);
      if (selfHit || kids.length > 0) {
        return { tag: node.tag, children: kids };
      }
      return null;
    };
    return tree.map(filterNode).filter((n): n is TagTreeNode => n != null);
  }, [tree, filterLower]);

  const createRoot = async () => {
    if (scoped) return;
    const name = await quickInput({
      title: t("tags.createTitle"),
      placeholder: t("tags.createPlaceholder"),
    });
    if (!name?.trim()) return;
    const parts = name
      .split("/")
      .map((s) => s.trim())
      .filter(Boolean);
    let parentId: string | null = null;
    for (const part of parts) {
      const created: TagDto = await unwrapCommand(
        commands.tagCreate(part, parentId, null),
      );
      parentId = created.id;
    }
    await refresh();
  };

  const createChild = async (parent: TagDto) => {
    if (scoped) return;
    const name = await quickInput({
      title: t("tags.createChildTitle", { path: parent.path }),
      placeholder: t("tags.createPlaceholder"),
    });
    if (!name?.trim()) return;
    await unwrapCommand(commands.tagCreate(name.trim(), parent.id, null));
    await refresh();
    setExpanded((prev) => new Set(prev).add(parent.id));
  };

  const renameTag = async (tag: TagDto) => {
    if (scoped || tag.kind === "system") return;
    const name = await quickInput({
      title: t("tags.renameTitle"),
      placeholder: tag.name,
      defaultValue: tag.name,
    });
    if (!name?.trim() || name.trim() === tag.name) return;
    await unwrapCommand(commands.tagRename(tag.id, name.trim()));
    await refresh();
  };

  const deleteTag = async (tag: TagDto) => {
    if (scoped || tag.kind === "system") return;
    const ok = await appConfirm(
      t("tags.deleteMessage", { path: tag.path }),
      t("tags.deleteTitle"),
    );
    if (!ok) return;
    try {
      await unwrapCommand(commands.tagDelete(tag.id, false));
    } catch {
      const cascade = await appConfirm(
        t("tags.deleteCascadeMessage"),
        t("tags.deleteCascadeTitle"),
      );
      if (!cascade) return;
      await unwrapCommand(commands.tagDelete(tag.id, true));
    }
    await refresh();
  };

  const renderNode = (node: TagTreeNode, depth: number) => {
    const { tag, children } = node;
    const isOpen = expanded.has(tag.id) || filterLower.length > 0;
    const selected = selectedIds.includes(tag.id);
    return (
      <div key={tag.id} className="tag-tree-node">
        <div
          className={`tag-tree-row${selected ? " tag-tree-row--selected" : ""}`}
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={(e: ReactMouseEvent) => {
            e.preventDefault();
            onToggle(tag.id);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            if (!scoped) void createChild(tag);
          }}
          onDoubleClick={() => {
            if (!scoped) void renameTag(tag);
          }}
        >
          {children.length > 0 ? (
            <button
              type="button"
              className={`tree-arrow${isOpen ? " tree-arrow--open" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                setExpanded((prev) => {
                  const next = new Set(prev);
                  if (next.has(tag.id)) next.delete(tag.id);
                  else next.add(tag.id);
                  return next;
                });
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="10" height="10">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>
          ) : (
            <span className="tag-tree-row__spacer" />
          )}
          <span className="tag-tree-row__hash">#</span>
          <span className="tag-tree-row__name" title={tag.path}>
            {tag.name}
          </span>
          {tag.resourceCount > 0 ? (
            <span className="tag-tree-row__count">{tag.resourceCount}</span>
          ) : null}
          {!scoped && tag.kind !== "system" ? (
            <button
              type="button"
              className="tag-tree-row__del"
              title={t("tags.deleteTitle")}
              onClick={(e) => {
                e.stopPropagation();
                void deleteTag(tag);
              }}
            >
              ×
            </button>
          ) : null}
        </div>
        {isOpen ? children.map((c) => renderNode(c, depth + 1)) : null}
      </div>
    );
  };

  const emptyText = scopedLoading
    ? t("common.loading")
    : scoped
      ? t("tags.emptyScoped")
      : t("tags.empty");

  return (
    <div className={`tag-tree-panel${className ? ` ${className}` : ""}`} data-tag-panel>
      <div className="tag-tree-panel__header">
        <span className="tag-tree-panel__title">{t("tags.panelTitle")}</span>
        <div className="tag-tree-panel__modes">
          <button
            type="button"
            className={matchMode === "and" ? "active" : ""}
            onClick={() => onMatchModeChange("and")}
          >
            AND
          </button>
          <button
            type="button"
            className={matchMode === "or" ? "active" : ""}
            onClick={() => onMatchModeChange("or")}
          >
            OR
          </button>
        </div>
        {!scoped ? (
          <button
            type="button"
            className="tag-tree-panel__add"
            onClick={() => void createRoot()}
            title={t("tags.createTitle")}
          >
            +
          </button>
        ) : null}
      </div>
      <input
        className="tag-tree-panel__filter"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={t("tags.filterPlaceholder")}
      />
      <div className="tag-tree-panel__body">
        {visibleTree.length === 0 ? (
          <div className="tag-tree-panel__empty">{emptyText}</div>
        ) : (
          visibleTree.map((n) => renderNode(n, 0))
        )}
      </div>
      {selectedIds.length > 0 ? (
        <div className="tag-tree-panel__footer">
          <button type="button" onClick={() => selectedIds.forEach((id) => onToggle(id))}>
            {t("tags.clearSelection")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
