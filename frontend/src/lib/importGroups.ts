import type { ImporterContribution } from "@omnipanel/plugin-sdk";
import { sortSshGroups } from "./sshGroups";

/** 导入分组写入的目标模块。 */
export type ImportGroupDest = "ssh" | "database" | "docker" | "panel";

export type ImportGroupField = {
  kind: string;
  dest: ImportGroupDest;
};

export type SidebarFolder = {
  id: string;
  name: string;
  parentId: string | null;
};

/** 导入分组：空表示挂到左侧树根级，不再把空值归一成「默认」。 */
export function sanitizeImportGroupInput(group: string): string {
  return group.trim();
}

/** 从已有文件夹路径收集下拉建议（含当前值，不含空根级）。 */
export function collectImportGroupSuggestions(
  existing: Array<string | null | undefined>,
  current?: string,
): string[] {
  const set = new Set<string>();
  for (const raw of existing) {
    const name = raw?.trim();
    if (name) set.add(name);
  }
  const normalized = current?.trim();
  if (normalized) set.add(normalized);
  return sortSshGroups([...set]);
}

export function sidebarFolderPath(folders: SidebarFolder[], folderId: string): string {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const parts: string[] = [];
  const seen = new Set<string>();
  let current = byId.get(folderId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    parts.unshift(current.name);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return parts.join(" / ");
}

export function listSidebarFolderPaths(folders: SidebarFolder[]): string[] {
  return sortSshGroups(folders.map((folder) => sidebarFolderPath(folders, folder.id)).filter(Boolean));
}

export function findSidebarFolder(folders: SidebarFolder[], path: string): SidebarFolder | undefined {
  const want = path.trim();
  if (!want) return undefined;
  return (
    folders.find((folder) => sidebarFolderPath(folders, folder.id) === want) ??
    folders.find((folder) => folder.parentId == null && folder.name === want)
  );
}

export function importGroupDest(remoteKind: string): ImportGroupDest {
  if (remoteKind === "ssh") return "ssh";
  if (remoteKind === "docker") return "docker";
  if (remoteKind === "panel") return "panel";
  return "database";
}

function uniqueKinds(kinds: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of kinds) {
    const kind = raw?.trim();
    if (!kind || seen.has(kind)) continue;
    seen.add(kind);
    out.push(kind);
  }
  return out;
}

/** Docker 库扫描只写数据库；其余按写入模块合并（MySQL/PostgreSQL 共用数据库分组）。 */
export function resolveImportGroupFields(input: {
  sourceKind?: string;
  resourceKinds?: string[];
  candidateKinds?: string[];
}): ImportGroupField[] {
  if (input.sourceKind === "dockerConnections") {
    return [{ kind: "database", dest: "database" }];
  }
  const kinds = uniqueKinds([...(input.resourceKinds ?? []), ...(input.candidateKinds ?? [])]);
  if (kinds.length === 0) {
    return [{ kind: "ssh", dest: "ssh" }];
  }
  const seen = new Set<ImportGroupDest>();
  const fields: ImportGroupField[] = [];
  for (const kind of kinds) {
    const dest = importGroupDest(kind);
    if (seen.has(dest)) continue;
    seen.add(dest);
    fields.push({ kind: dest, dest });
  }
  return fields;
}

export function importGroupKeyForCandidate(
  _sourceKind: string | undefined,
  remoteKind: string,
): string {
  return importGroupDest(remoteKind);
}

export function defaultImportGroups(
  fields: ImportGroupField[],
  opts: { defaultGroup: string },
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const field of fields) {
    next[field.kind] = field.dest === "database" ? "" : sanitizeImportGroupInput(opts.defaultGroup);
  }
  return next;
}

export function mergeImportGroups(
  prev: Record<string, string>,
  fields: ImportGroupField[],
  defaults: Record<string, string>,
): Record<string, string> {
  let changed = false;
  const next = { ...prev };
  for (const field of fields) {
    if (!(field.kind in next)) {
      next[field.kind] = defaults[field.kind] ?? "";
      changed = true;
    }
  }
  return changed ? next : prev;
}

export function groupForImporter(
  importer: ImporterContribution | undefined,
  importGroups: Record<string, string>,
  remoteKind: string,
): string {
  const key = importGroupKeyForCandidate(importer?.sourceKind, remoteKind);
  const chosen = importGroups[key];
  if (chosen != null) return sanitizeImportGroupInput(chosen);
  if (importGroupDest(remoteKind) === "database") return "";
  return sanitizeImportGroupInput(importer?.defaultGroup || "");
}
