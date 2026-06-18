import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type DbSqlFileNodeType = "folder" | "file";

export interface DbSqlFileNode {
  id: string;
  type: DbSqlFileNodeType;
  name: string;
  parentId: string | null;
  sql?: string;
  /** 上次在此文件上选用的数据库连接 */
  connId?: string;
  /** 上次在此文件上选用的数据库名 */
  database?: string;
  updatedAt: number;
}

interface DbSqlFileState {
  nodes: DbSqlFileNode[];
  addFolder: (parentId: string | null, name: string) => DbSqlFileNode;
  addFile: (parentId: string | null, name: string, sql?: string) => DbSqlFileNode;
  updateFileSql: (id: string, sql: string) => void;
  updateFileBinding: (id: string, connId: string, database: string) => void;
  renameNode: (id: string, name: string) => boolean;
  deleteNode: (id: string) => void;
  getNode: (id: string) => DbSqlFileNode | undefined;
}

function makeId(prefix: string): string {
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

function uniqueName(
  nodes: DbSqlFileNode[],
  parentId: string | null,
  name: string,
  excludeId?: string,
): string {
  const base = name.trim() || "untitled";
  const siblings = nodes.filter((node) => node.parentId === parentId && node.id !== excludeId);
  if (!siblings.some((node) => node.name === base)) {
    return base;
  }
  let index = 2;
  while (siblings.some((node) => node.name === `${base} ${index}`)) {
    index += 1;
  }
  return `${base} ${index}`;
}

function collectDescendantIds(nodes: DbSqlFileNode[], rootId: string): Set<string> {
  const ids = new Set<string>([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (node.parentId && ids.has(node.parentId) && !ids.has(node.id)) {
        ids.add(node.id);
        changed = true;
      }
    }
  }
  return ids;
}

export function getSqlFileChildren(
  nodes: DbSqlFileNode[],
  parentId: string | null,
): DbSqlFileNode[] {
  return nodes
    .filter((node) => node.parentId === parentId)
    .sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "folder" ? -1 : 1;
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
}

export const useDbSqlFileStore = create<DbSqlFileState>()(
  persist(
    (set, get) => ({
      nodes: [],

      addFolder: (parentId, name) => {
        const node: DbSqlFileNode = {
          id: makeId("sql-folder"),
          type: "folder",
          name: uniqueName(get().nodes, parentId, name),
          parentId,
          updatedAt: Date.now(),
        };
        set((state) => ({ nodes: [...state.nodes, node] }));
        return node;
      },

      addFile: (parentId, name, sql = "") => {
        const fileName = uniqueName(get().nodes, parentId, name.endsWith(".sql") ? name : `${name}.sql`);
        const node: DbSqlFileNode = {
          id: makeId("sql-file"),
          type: "file",
          name: fileName,
          parentId,
          sql,
          updatedAt: Date.now(),
        };
        set((state) => ({ nodes: [...state.nodes, node] }));
        return node;
      },

      updateFileSql: (id, sql) => {
        set((state) => ({
          nodes: state.nodes.map((node) =>
            node.id === id && node.type === "file"
              ? { ...node, sql, updatedAt: Date.now() }
              : node,
          ),
        }));
      },

      updateFileBinding: (id, connId, database) => {
        set((state) => ({
          nodes: state.nodes.map((node) =>
            node.id === id && node.type === "file"
              ? {
                  ...node,
                  connId: connId || undefined,
                  database: database || undefined,
                  updatedAt: Date.now(),
                }
              : node,
          ),
        }));
      },

      renameNode: (id, name) => {
        const trimmed = name.trim();
        if (!trimmed) {
          return false;
        }
        const node = get().nodes.find((entry) => entry.id === id);
        if (!node) {
          return false;
        }
        const nextName =
          node.type === "file" && !trimmed.endsWith(".sql") ? `${trimmed}.sql` : trimmed;
        set((state) => ({
          nodes: state.nodes.map((entry) =>
            entry.id === id
              ? {
                  ...entry,
                  name: uniqueName(state.nodes, entry.parentId, nextName, entry.id),
                  updatedAt: Date.now(),
                }
              : entry,
          ),
        }));
        return true;
      },

      deleteNode: (id) => {
        const removeIds = collectDescendantIds(get().nodes, id);
        set((state) => ({
          nodes: state.nodes.filter((node) => !removeIds.has(node.id)),
        }));
      },

      getNode: (id) => get().nodes.find((node) => node.id === id),
    }),
    {
      name: "omnipanel-db-sql-files",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
