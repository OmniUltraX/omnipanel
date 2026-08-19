import { buildTerminalAiContextAppend } from "../../modules/terminal/buildTerminalAiContext";
import {
  connectionToResource,
  useConnectionStore,
} from "../../stores/connectionStore";
import { getDbConnectionList } from "../../stores/dbConnectionListStore";
import type { ComposerContextItem } from "../../stores/aiComposerContextStore";
import { getComposerContextItems } from "../../stores/aiComposerContextStore";

function kindTitle(kind: ComposerContextItem["kind"]): string {
  switch (kind) {
    case "terminal":
      return "终端会话上下文";
    case "ssh":
      return "SSH 主机上下文";
    case "database":
      return "数据库连接上下文";
    case "docker":
      return "Docker 连接上下文";
  }
}

function buildDatabaseItemAppend(item: ComposerContextItem): string {
  const conn = getDbConnectionList().find((c) => c.id === item.id);
  if (!conn) {
    return [`## ${kindTitle("database")}`, `- 连接：${item.label}`, `- 连接 ID：${item.id}`].join(
      "\n",
    );
  }
  const lines = [
    `## ${kindTitle("database")}`,
    `- 连接名称：${conn.name}`,
    `- 连接 ID：${conn.id}`,
    `- 引擎：${conn.db_type}`,
  ];
  if (conn.host) {
    lines.push(`- 地址：${conn.host}${conn.port > 0 ? `:${conn.port}` : ""}`);
  }
  if (conn.user) lines.push(`- 用户：${conn.user}`);
  if (conn.database) lines.push(`- 默认库：${conn.database}`);
  return lines.join("\n");
}

function buildConnectionItemAppend(item: ComposerContextItem): string {
  if (item.kind === "database") {
    return buildDatabaseItemAppend(item);
  }
  const conn = useConnectionStore.getState().connections.find((c) => c.id === item.id);
  if (!conn) {
    return [`## ${kindTitle(item.kind)}`, `- 连接：${item.label}`, `- 连接 ID：${item.id}`].join(
      "\n",
    );
  }
  const resource = connectionToResource(conn);
  const lines = [
    `## ${kindTitle(item.kind)}`,
    `- 连接名称：${resource.name}`,
    `- 连接 ID：${resource.id}`,
  ];
  if (resource.subtitle) lines.push(`- 地址：${resource.subtitle}`);
  if (resource.environment) lines.push(`- 环境：${resource.environment}`);
  return lines.join("\n");
}

export type ComposerAppendOptions = {
  /** 活动会话已单独注入 Terminal Context 时，跳过同 id 芯片，避免双份。 */
  skipTerminalSessionId?: string | null;
};

/** 将 Composer 显式芯片转为可注入 system/user 的上下文文本。 */
export function buildComposerExplicitContextAppend(
  items: ComposerContextItem[] = getComposerContextItems(),
  options?: ComposerAppendOptions,
): string | null {
  if (items.length === 0) return null;
  const skipId = options?.skipTerminalSessionId?.trim() || null;
  const segments: string[] = [];
  for (const item of items) {
    if (item.kind === "terminal") {
      if (skipId && item.id === skipId) continue;
      const text = buildTerminalAiContextAppend(item.id);
      if (text && text.trim()) {
        segments.push(text);
      } else {
        segments.push(
          [`## ${kindTitle("terminal")}`, `- 会话：${item.label}`, `- 会话 ID：${item.id}`].join(
            "\n",
          ),
        );
      }
      continue;
    }
    segments.push(buildConnectionItemAppend(item));
  }
  if (segments.length === 0) return null;
  return segments.join("\n\n---\n\n");
}

export function mergeAiContextAppend(...parts: Array<string | null | undefined>): string | null {
  const segments = parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  if (segments.length === 0) return null;
  return segments.join("\n\n---\n\n");
}
