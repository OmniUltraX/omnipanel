import { buildTerminalAiContextAppend } from "../../modules/terminal/buildTerminalAiContext";
import {
  connectionToResource,
  useConnectionStore,
} from "../../stores/connectionStore";
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

function buildConnectionItemAppend(item: ComposerContextItem): string {
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

/** 将 Composer 显式芯片转为可注入 system/user 的上下文文本。 */
export function buildComposerExplicitContextAppend(
  items: ComposerContextItem[] = getComposerContextItems(),
): string | null {
  if (items.length === 0) return null;
  const segments: string[] = [];
  for (const item of items) {
    if (item.kind === "terminal") {
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
