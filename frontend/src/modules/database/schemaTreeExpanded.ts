/** Schema 树展开状态快照（与 Rust `SchemaTreeExpandedSnapshot` 对应）。 */
export interface SchemaTreeExpandedSnapshot {
  expandedNodeIds: string[];
}

export function connectionNodeId(connId: string): string {
  return `conn:${connId}`;
}
