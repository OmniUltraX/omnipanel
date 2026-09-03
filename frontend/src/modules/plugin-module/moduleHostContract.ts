import type { ModuleActionDecl, ModuleActionTarget, ModuleCapabilityDecl } from "@omnipanel/plugin-sdk";

const FALLBACK_LIST: Record<string, string> = {
  namespace: "listNamespaces",
  config: "listConfigs",
  discovery: "listServices",
  cluster: "listNodes",
};

const FALLBACK_GET: Record<string, string> = {
  config: "getConfig",
};

const FALLBACK_KEY: Record<string, string> = {
  namespace: "namespaceId",
  config: "group,dataId",
  discovery: "serviceName",
  cluster: "address",
};

export function capabilityLabel(
  cap: Pick<ModuleCapabilityDecl, "id" | "label">,
  t: (key: string) => string,
): string {
  const declared = cap.label?.trim();
  if (declared) return declared;
  const key = `moduleHost.capability.${cap.id}`;
  const translated = t(key);
  return translated === key ? cap.id : translated;
}

export function capabilityListMethod(cap: ModuleCapabilityDecl): string {
  return cap.listMethod?.trim() || FALLBACK_LIST[cap.id] || "listItems";
}

export function capabilityGetMethod(cap: ModuleCapabilityDecl): string | null {
  return cap.getMethod?.trim() || FALLBACK_GET[cap.id] || null;
}

export function capabilityItemKey(cap: ModuleCapabilityDecl): string {
  return cap.itemKey?.trim() || FALLBACK_KEY[cap.id] || "id";
}

export function capabilityChildItemKey(cap: ModuleCapabilityDecl): string {
  return cap.childItemKey?.trim() || "id";
}

export function capabilityChildListMethod(cap: ModuleCapabilityDecl): string {
  return cap.childListMethod?.trim() || capabilityListMethod(cap);
}

export type ModulePaneKind = NonNullable<ModuleCapabilityDecl["detail"]>;

export function capabilityPane(cap: ModuleCapabilityDecl): ModulePaneKind {
  const detail = cap.detail;
  if (
    detail === "editor" ||
    detail === "children" ||
    detail === "none" ||
    detail === "form" ||
    detail === "kv" ||
    detail === "logs" ||
    detail === "metrics" ||
    detail === "facts" ||
    detail === "tree"
  ) {
    return detail;
  }
  if (cap.id === "config") return "editor";
  if (cap.id === "discovery") return "children";
  return "none";
}

/** @deprecated 用 capabilityPane */
export function capabilityDetail(cap: ModuleCapabilityDecl): ModulePaneKind {
  return capabilityPane(cap);
}

export function isSplitPane(kind: ModulePaneKind): boolean {
  return kind === "editor" || kind === "children" || kind === "form" || kind === "kv" || kind === "tree";
}

export function capabilityLanguage(
  cap: ModuleCapabilityDecl,
): "yaml" | "json" | "text" | "sql" | "ini" | "shell" | "python" {
  const language = cap.language;
  if (
    language === "json" ||
    language === "text" ||
    language === "sql" ||
    language === "ini" ||
    language === "shell" ||
    language === "python" ||
    language === "yaml"
  ) {
    return language;
  }
  return "yaml";
}

export function capabilityValueKey(cap: ModuleCapabilityDecl): string {
  return cap.valueKey?.trim() || "content";
}

export function actionMethod(action: Pick<ModuleActionDecl, "id" | "method">): string {
  return action.method?.trim() || action.id;
}

export function actionTarget(
  action: Pick<ModuleActionDecl, "id" | "target">,
  detail: ModulePaneKind,
): ModuleActionTarget {
  if (
    action.target === "toolbar" ||
    action.target === "row" ||
    action.target === "editor" ||
    action.target === "child" ||
    action.target === "history"
  ) {
    return action.target;
  }
  if (action.id === "create" || action.id === "new") return "toolbar";
  if (action.id === "update" || action.id === "edit") return "row";
  if (action.id === "rollback") return "history";
  if (action.id === "delete") return detail === "editor" ? "editor" : "row";
  if (detail === "children") return "child";
  if (detail === "editor" || detail === "kv" || detail === "form" || detail === "tree") return "editor";
  return "row";
}

export function actionLabel(action: Pick<ModuleActionDecl, "id" | "label">, t: (key: string) => string): string {
  const declared = action.label?.trim();
  if (declared) return declared;
  const key = `moduleHost.action.${action.id}`;
  const translated = t(key);
  if (translated !== key) return translated;
  const legacy = `moduleHost.${action.id}`;
  const legacyText = t(legacy);
  return legacyText !== legacy ? legacyText : action.id;
}

export function isDangerAction(action: Pick<ModuleActionDecl, "id" | "method">): boolean {
  const token = `${action.id} ${actionMethod(action)}`.toLowerCase();
  return token.includes("delete") || token.includes("remove");
}

export function isProtectedRow(row: Record<string, unknown>, itemKey: string): boolean {
  const key = rowItemKey(row, itemKey).trim().toLowerCase();
  return key === "" || key === "public";
}

export function rowField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

export function rowItemKey(row: Record<string, unknown>, key: string): string {
  if (key.includes(",")) {
    return (
      key
        .split(",")
        .map((part) => rowField(row, part.trim()))
        .filter(Boolean)
        .join(":") || rowField(row, "id")
    );
  }
  return rowField(row, key) || rowField(row, "id");
}

export function formatCell(t: (key: string) => string, key: string, raw: unknown): string {
  if (typeof raw === "boolean") {
    if (key === "healthy") return raw ? t("moduleHost.healthyOk") : t("moduleHost.healthyDown");
    return raw ? t("moduleHost.enable") : t("moduleHost.disable");
  }
  return rowField({ [key]: raw }, key) || "—";
}

export function extractItems(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
  }
  if (payload && typeof payload === "object") {
    const items = (payload as { items?: unknown }).items;
    if (Array.isArray(items)) {
      return items.filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
    }
  }
  return [];
}

export type ModuleTreeNode = {
  id: string;
  label: string;
  leaf: boolean;
  children: ModuleTreeNode[];
  raw: Record<string, unknown>;
};

function treeNodeFromRow(row: Record<string, unknown>, itemKey: string, children: ModuleTreeNode[]): ModuleTreeNode {
  const id = rowItemKey(row, itemKey) || rowField(row, "path") || rowField(row, "name");
  const leaf =
    row.leaf === true || row.hasChildren === false
      ? true
      : row.leaf === false || row.hasChildren === true || children.length > 0
        ? false
        : true;
  return {
    id,
    label: rowField(row, "label") || rowField(row, "name") || id,
    leaf,
    children,
    raw: row,
  };
}

function nestFromChildren(row: Record<string, unknown>, itemKey: string): ModuleTreeNode {
  const rawChildren = Array.isArray(row.children) ? row.children : [];
  const children = rawChildren
    .filter((child): child is Record<string, unknown> => !!child && typeof child === "object")
    .map((child) => nestFromChildren(child, itemKey));
  return treeNodeFromRow(row, itemKey, children);
}

function nestFromParentId(rows: Record<string, unknown>[], itemKey: string): ModuleTreeNode[] {
  const byParent = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const parent = rowField(row, "parentId") || rowField(row, "parent") || "";
    const list = byParent.get(parent) ?? [];
    list.push(row);
    byParent.set(parent, list);
  }
  const walk = (parentId: string): ModuleTreeNode[] =>
    (byParent.get(parentId) ?? []).map((row) => {
      const id = rowItemKey(row, itemKey) || rowField(row, "path") || rowField(row, "name");
      return treeNodeFromRow(row, itemKey, walk(id));
    });
  const rooted = walk("");
  if (rooted.length > 0) return rooted;
  const known = new Set(rows.map((row) => rowItemKey(row, itemKey) || rowField(row, "path") || rowField(row, "name")));
  return rows
    .filter((row) => {
      const parent = rowField(row, "parentId") || rowField(row, "parent");
      return !parent || !known.has(parent);
    })
    .map((row) => {
      const id = rowItemKey(row, itemKey) || rowField(row, "path") || rowField(row, "name");
      return treeNodeFromRow(row, itemKey, walk(id));
    });
}

export function extractTree(payload: unknown, itemKey = "id"): ModuleTreeNode[] {
  const rows = extractItems(payload);
  if (rows.some((row) => Array.isArray(row.children))) {
    return rows.map((row) => nestFromChildren(row, itemKey));
  }
  if (rows.some((row) => rowField(row, "parentId") || rowField(row, "parent"))) {
    return nestFromParentId(rows, itemKey);
  }
  return rows.map((row) => treeNodeFromRow(row, itemKey, []));
}

export function mergeTreeChildren(
  roots: ModuleTreeNode[],
  parentId: string,
  children: ModuleTreeNode[],
): ModuleTreeNode[] {
  return roots.map((node) => {
    if (node.id === parentId) return { ...node, leaf: children.length === 0 && node.leaf, children };
    if (node.children.length === 0) return node;
    return { ...node, children: mergeTreeChildren(node.children, parentId, children) };
  });
}

export function flattenTree(nodes: ModuleTreeNode[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (list: ModuleTreeNode[]) => {
    for (const node of list) {
      out.push(node.raw);
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

export function filterTree(nodes: ModuleTreeNode[], query: string): ModuleTreeNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;
  const walk = (list: ModuleTreeNode[]): ModuleTreeNode[] =>
    list
      .map((node) => {
        const kids = walk(node.children);
        const hit = node.label.toLowerCase().includes(q) || node.id.toLowerCase().includes(q);
        if (!hit && kids.length === 0) return null;
        return { ...node, children: kids };
      })
      .filter((node): node is ModuleTreeNode => node != null);
  return walk(nodes);
}

export function extractFacts(payload: unknown): { key: string; value: string }[] {
  if (payload && typeof payload === "object") {
    const facts = (payload as { facts?: unknown }).facts;
    if (facts && typeof facts === "object" && !Array.isArray(facts)) {
      return Object.entries(facts as Record<string, unknown>).map(([key, value]) => ({
        key,
        value: value == null ? "" : String(value),
      }));
    }
  }
  return extractItems(payload)
    .map((row) => ({
      key: rowField(row, "key") || rowField(row, "name"),
      value: rowField(row, "value") || rowField(row, "content"),
    }))
    .filter((row) => row.key);
}

export type ModuleMetricSeries = {
  id: string;
  label: string;
  unit: string;
  points: { tsMs: number; value: number }[];
};

export function extractMetrics(payload: unknown): ModuleMetricSeries[] {
  return extractItems(payload)
    .map((row) => {
      const pointsRaw = row.points;
      const points = Array.isArray(pointsRaw)
        ? pointsRaw
            .map((point) => {
              if (!point || typeof point !== "object") return null;
              const rec = point as { tsMs?: unknown; t?: unknown; ts?: unknown; value?: unknown; v?: unknown };
              const ts = Number(rec.tsMs ?? rec.t ?? rec.ts ?? 0);
              const value = Number(rec.value ?? rec.v ?? NaN);
              if (!Number.isFinite(ts) || !Number.isFinite(value)) return null;
              return { tsMs: ts, value };
            })
            .filter((point): point is { tsMs: number; value: number } => point != null)
        : [];
      const id = rowField(row, "id") || rowField(row, "name");
      return {
        id,
        label: rowField(row, "label") || rowField(row, "name") || id,
        unit: rowField(row, "unit"),
        points,
      };
    })
    .filter((row) => row.id);
}

export function emptyFormDraft(fields: { key: string }[]): Record<string, string> {
  return Object.fromEntries(fields.map((field) => [field.key, ""]));
}

export function rowToFormDraft(row: Record<string, unknown>, fields: { key: string }[]): Record<string, string> {
  return Object.fromEntries(fields.map((field) => [field.key, rowField(row, field.key)]));
}
