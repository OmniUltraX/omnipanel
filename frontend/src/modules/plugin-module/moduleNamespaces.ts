export type ModuleNamespaceRow = {
  namespaceId: string;
  name: string;
  description?: string;
  configCount?: number;
};

export const PUBLIC_NAMESPACE_SELECT = "__public__";

export function namespaceSelectValue(namespaceId: string): string {
  return namespaceId.trim() === "" ? PUBLIC_NAMESPACE_SELECT : namespaceId;
}

export function namespaceIdFromSelect(value: string): string {
  return value === PUBLIC_NAMESPACE_SELECT ? "" : value;
}

export function isPublicNamespace(namespaceId: string): boolean {
  return namespaceId.trim() === "";
}
