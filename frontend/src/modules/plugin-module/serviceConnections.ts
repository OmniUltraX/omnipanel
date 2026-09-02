import type { Connection } from "../../ipc/bindings";
import { servicePluginId } from "../../lib/moduleCapabilities";

export function listServiceConnections(
  connections: Connection[],
  pluginId: string,
): Connection[] {
  const id = pluginId.trim();
  if (!id) return [];
  return connections.filter(
    (conn) => conn.kind === "service" && servicePluginId(conn.config) === id,
  );
}

export function connectionHostPort(connection: Connection): string {
  try {
    const cfg = JSON.parse(connection.config || "{}") as { host?: unknown; port?: unknown };
    const host = typeof cfg.host === "string" ? cfg.host : "";
    const port = typeof cfg.port === "number" ? cfg.port : Number(cfg.port || 0);
    return host ? `${host}${port ? `:${port}` : ""}` : "";
  } catch {
    return "";
  }
}

/** 连接上记住的当前命名空间；空字符串表示默认 public。 */
export function connectionNamespaceId(connection: Connection): string {
  try {
    const cfg = JSON.parse(connection.config || "{}") as { namespaceId?: unknown };
    return typeof cfg.namespaceId === "string" ? cfg.namespaceId.trim() : "";
  } catch {
    return "";
  }
}

export function withConnectionNamespaceId(connection: Connection, namespaceId: string): Connection {
  try {
    const cfg = JSON.parse(connection.config || "{}") as Record<string, unknown>;
    return {
      ...connection,
      config: JSON.stringify({ ...cfg, namespaceId }),
    };
  } catch {
    return {
      ...connection,
      config: JSON.stringify({ namespaceId }),
    };
  }
}
