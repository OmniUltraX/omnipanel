import { useCallback, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useI18n } from "../../i18n";
import { Button } from "../../components/ui/Button";
import { ScopedSearch } from "../../components/ui/ScopedSearch";
import { ContextMenu } from "../../components/ui/ContextMenu";
import { quickInput } from "../../lib/quickInput";
import { textSearchMatches } from "../../lib/textSearchMatch";
import { useDbSqlFileStore, getSqlFileChildren, type DbSqlFileNode } from "../../stores/dbSqlFileStore";
import type { SchemaSidebarSectionConfig } from "./SchemaSidebarSection";
import { SchemaSidebarSection } from "./SchemaSidebarSection";

interface SqlQueryFilePanelProps {
  onOpenFile: (file: DbSqlFileNode) => void;
  section?: SchemaSidebarSectionConfig;
}

function FolderTree({
  allNodes,
  parentId,
  depth,
  search,
  expandedIds,
  onToggleFolder,
  onOpenFile,
  onContextMenu,
  activeFileId,
}: {
  allNodes: DbSqlFileNode[];
  parentId: string | null;
  depth: number;
  search: string;
  expandedIds: Set<string>;
  onToggleFolder: (id: string) => void;
  onOpenFile: (file: DbSqlFileNode) => void;
  onContextMenu: (node: DbSqlFileNode, event: ReactMouseEvent) => void;
  activeFileId?: string | null;
}) {
  const nodes = useMemo(
    () => getSqlFileChildren(allNodes, parentId),
    [allNodes, parentId],
  );
  const q = search.trim();

  const visibleNodes = useMemo(() => {
    if (!q) {
      return nodes;
    }
    return nodes.filter((node) => textSearchMatches(q, node.name));
  }, [nodes, q]);

  if (visibleNodes.length === 0) {
    return null;
  }

  return (
    <>
      {visibleNodes.map((node) => {
        const indent = depth * 16 + 8;
        if (node.type === "folder") {
          const expanded = expandedIds.has(node.id);
          return (
            <div key={node.id}>
              <div
                className="sql-file-tree-node sql-file-tree-node--folder"
                style={{ paddingLeft: indent }}
                onContextMenu={(event) => onContextMenu(node, event)}
              >
                <span
                  className={`tree-arrow${expanded ? " tree-arrow--open" : ""}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleFolder(node.id);
                  }}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="10" height="10">
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                </span>
                <span className="tree-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="13" height="13">
                    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                  </svg>
                </span>
                <span
                  className="tree-label"
                  onClick={() => onToggleFolder(node.id)}
                >
                  {node.name}
                </span>
              </div>
              {expanded && (
                <FolderTree
                  allNodes={allNodes}
                  parentId={node.id}
                  depth={depth + 1}
                  search={search}
                  expandedIds={expandedIds}
                  onToggleFolder={onToggleFolder}
                  onOpenFile={onOpenFile}
                  onContextMenu={onContextMenu}
                  activeFileId={activeFileId}
                />
              )}
            </div>
          );
        }

        return (
          <div
            key={node.id}
            className={`sql-file-tree-node sql-file-tree-node--file${activeFileId === node.id ? " sql-file-tree-node--active" : ""}`}
            style={{ paddingLeft: indent }}
            onClick={() => onOpenFile(node)}
            onContextMenu={(event) => onContextMenu(node, event)}
          >
            <span className="tree-arrow tree-leaf">
              <span className="tree-dot" />
            </span>
            <span className="tree-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="13" height="13">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                <path d="M14 2v6h6" />
                <path d="M8 13h8M8 17h5" />
              </svg>
            </span>
            <span className="tree-label">{node.name}</span>
          </div>
        );
      })}
    </>
  );
}

export function SqlQueryFilePanel({ onOpenFile, section }: SqlQueryFilePanelProps) {
  const { t } = useI18n();
  const nodes = useDbSqlFileStore((s) => s.nodes);
  const addFolder = useDbSqlFileStore((s) => s.addFolder);
  const addFile = useDbSqlFileStore((s) => s.addFile);
  const renameNode = useDbSqlFileStore((s) => s.renameNode);
  const deleteNode = useDbSqlFileStore((s) => s.deleteNode);
  const [search, setSearch] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; node: DbSqlFileNode } | null>(null);

  const toggleFolder = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleOpenFile = useCallback(
    (file: DbSqlFileNode) => {
      setActiveFileId(file.id);
      onOpenFile(file);
    },
    [onOpenFile],
  );

  const handleCreateFolder = useCallback(async (parentId: string | null = null) => {
    const name = await quickInput({
      title: t("database.queryFiles.newFolderTitle"),
      placeholder: t("database.queryFiles.folderNamePlaceholder"),
      defaultValue: t("database.queryFiles.defaultFolderName"),
      validate: (value) => (value.trim() ? null : t("database.queryFiles.nameRequired")),
    });
    if (!name) {
      return;
    }
    const folder = addFolder(parentId, name.trim());
    setExpandedIds((prev) => new Set(prev).add(folder.id));
  }, [addFolder, t]);

  const handleCreateFile = useCallback(async (parentId: string | null = null) => {
    const name = await quickInput({
      title: t("database.queryFiles.newFileTitle"),
      placeholder: t("database.queryFiles.fileNamePlaceholder"),
      defaultValue: t("database.queryFiles.defaultFileName"),
      validate: (value) => (value.trim() ? null : t("database.queryFiles.nameRequired")),
    });
    if (!name) {
      return;
    }
    const file = addFile(parentId, name.trim());
    handleOpenFile(file);
  }, [addFile, handleOpenFile, t]);

  const handleRename = useCallback(
    async (node: DbSqlFileNode) => {
      const name = await quickInput({
        title: t("database.queryFiles.renameTitle"),
        defaultValue: node.name.replace(/\.sql$/i, ""),
        validate: (value) => (value.trim() ? null : t("database.queryFiles.nameRequired")),
      });
      if (!name) {
        return;
      }
      renameNode(node.id, name.trim());
    },
    [renameNode, t],
  );

  const rootCount = nodes.filter((node) => node.parentId === null).length;

  const toolbar = (
    <div className="schema-toolbar schema-toolbar--inline">
      <Button variant="icon" title={t("database.queryFiles.newFile")} onClick={() => void handleCreateFile()}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
          <path d="M14 2v6h6M12 11v6M9 14h6" />
        </svg>
      </Button>
      <Button variant="icon" title={t("database.queryFiles.newFolder")} onClick={() => void handleCreateFolder()}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
          <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2v-5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
          <path d="M12 11v6M9 14h6" />
        </svg>
      </Button>
    </div>
  );

  const panelBody = (
    <div className="sql-query-file-panel">
      {!section && toolbar}
      <ScopedSearch
        className="sql-query-file-search"
        value={search}
        onChange={setSearch}
        placeholder={t("database.queryFiles.search")}
      >
        <div className="sql-query-file-tree">
          {rootCount === 0 ? (
            <div className="sql-query-file-empty">{t("database.queryFiles.empty")}</div>
          ) : (
            <FolderTree
              allNodes={nodes}
              parentId={null}
              depth={0}
              search={search}
              expandedIds={expandedIds}
              onToggleFolder={toggleFolder}
              onOpenFile={handleOpenFile}
              onContextMenu={(node, event) => {
                event.preventDefault();
                setCtxMenu({ x: event.clientX, y: event.clientY, node });
              }}
              activeFileId={activeFileId}
            />
          )}
        </div>
      </ScopedSearch>
      {ctxMenu && (
        <ContextMenu
          position={{ x: ctxMenu.x, y: ctxMenu.y }}
          items={[
            ...(ctxMenu.node.type === "folder"
              ? [
                  {
                    id: "new-file",
                    label: t("database.queryFiles.newFile"),
                    onClick: () => void handleCreateFile(ctxMenu.node.id),
                  },
                  {
                    id: "new-folder",
                    label: t("database.queryFiles.newFolder"),
                    onClick: () => void handleCreateFolder(ctxMenu.node.id),
                  },
                ]
              : []),
            {
              id: "rename",
              label: t("database.queryFiles.rename"),
              onClick: () => void handleRename(ctxMenu.node),
            },
            {
              id: "delete",
              label: t("database.queryFiles.delete"),
              danger: true,
              onClick: () => deleteNode(ctxMenu.node.id),
            },
          ]}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );

  if (section) {
    return (
      <SchemaSidebarSection {...section} actions={toolbar}>
        {panelBody}
      </SchemaSidebarSection>
    );
  }

  return panelBody;
}
