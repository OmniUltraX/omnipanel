import type { McpEnvEntry, McpTransportKind, UpsertMcpServiceInput } from "../../ipc/bindings";
import {
  isBuiltinOmniMcpUrl,
  OMNIMCP_BUILTIN_MCP_URL,
} from "../ai/localServicePorts";

export const BUILTIN_OMNIMCP_URL = OMNIMCP_BUILTIN_MCP_URL;
export { isBuiltinOmniMcpUrl };

export interface ParsedMcpServerConfig {
  /** mcpServers 中的键名 */
  key: string;
  name: string;
  transportKind: McpTransportKind;
  command?: string;
  args?: string[];
  env?: McpEnvEntry[];
  cwd?: string;
  url?: string;
  enabled: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEnv(value: unknown): McpEnvEntry[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (!isRecord(item)) return null;
        const key = typeof item.key === "string" ? item.key.trim() : "";
        const val = typeof item.value === "string" ? item.value : "";
        return key ? { key, value: val } : null;
      })
      .filter((item): item is McpEnvEntry => item !== null);
  }
  if (isRecord(value)) {
    return Object.entries(value)
      .filter(([k]) => k.trim().length > 0)
      .map(([key, val]) => ({ key, value: typeof val === "string" ? val : String(val ?? "") }));
  }
  return [];
}

function parseArgs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function parseServerEntry(key: string, entry: Record<string, unknown>): ParsedMcpServerConfig | null {
  const name = key.trim();
  if (!name) return null;

  const url =
    typeof entry.url === "string"
      ? entry.url.trim()
      : typeof entry.serverUrl === "string"
        ? entry.serverUrl.trim()
        : "";

  if (url) {
    return {
      key: name,
      name,
      transportKind: "sse",
      url,
      enabled: true,
    };
  }

  const command = typeof entry.command === "string" ? entry.command.trim() : "";
  if (command) {
    return {
      key: name,
      name,
      transportKind: "stdio",
      command,
      args: parseArgs(entry.args),
      env: parseEnv(entry.env),
      cwd: typeof entry.cwd === "string" && entry.cwd.trim() ? entry.cwd.trim() : undefined,
      enabled: true,
    };
  }

  return null;
}

function serversFromMap(map: Record<string, unknown>): ParsedMcpServerConfig[] {
  const results: ParsedMcpServerConfig[] = [];
  for (const [key, value] of Object.entries(map)) {
    if (!isRecord(value)) continue;
    const parsed = parseServerEntry(key, value);
    if (parsed) results.push(parsed);
  }
  return results;
}

function looksLikeServerMap(map: Record<string, unknown>): boolean {
  return Object.values(map).some(
    (value) =>
      isRecord(value) &&
      (typeof value.url === "string" ||
        typeof value.serverUrl === "string" ||
        typeof value.command === "string"),
  );
}

export function parseMcpConfigJson(text: string): ParsedMcpServerConfig[] {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("JSON 为空");
  }

  let root: unknown;
  try {
    root = JSON.parse(trimmed);
  } catch {
    throw new Error("JSON 格式无效");
  }

  if (!isRecord(root)) {
    throw new Error("根节点必须是 JSON 对象");
  }

  let servers: ParsedMcpServerConfig[] = [];

  if (isRecord(root.mcpServers)) {
    servers = serversFromMap(root.mcpServers);
  } else if (looksLikeServerMap(root)) {
    servers = serversFromMap(root);
  } else if (typeof root.url === "string" || typeof root.command === "string") {
    const single = parseServerEntry(
      typeof root.name === "string" && root.name.trim() ? root.name.trim() : "imported",
      root,
    );
    servers = single ? [single] : [];
  }

  if (servers.length === 0) {
    throw new Error("未识别到 MCP 服务配置（需包含 url 或 command）");
  }

  return servers;
}

export function toUpsertMcpServiceInput(server: ParsedMcpServerConfig): UpsertMcpServiceInput {
  return {
    id: null,
    name: server.name,
    enabled: server.enabled,
    transportKind: server.transportKind,
    command: server.transportKind === "stdio" ? (server.command ?? null) : null,
    args: server.transportKind === "stdio" ? (server.args ?? []) : [],
    env: server.transportKind === "stdio" ? (server.env ?? []) : [],
    cwd: server.transportKind === "stdio" ? (server.cwd ?? null) : null,
    url: server.transportKind === "sse" ? (server.url ?? null) : null,
  };
}

export function parsedServerSummary(server: ParsedMcpServerConfig): string {
  if (server.transportKind === "sse") {
    return server.url ?? "";
  }
  const args = server.args?.length ? ` ${server.args.join(" ")}` : "";
  return `${server.command ?? ""}${args}`.trim();
}
