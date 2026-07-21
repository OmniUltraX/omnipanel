import { useMemo } from "react";

import type { ComposerContextItem } from "../../../stores/aiComposerContextStore";
import { useAiComposerContextStore } from "../../../stores/aiComposerContextStore";
import { useConnectionStore } from "../../../stores/connectionStore";
import { useTerminalStore } from "../../../stores/terminalStore";

export type ComposerContextCategoryId =
  | "attachment"
  | "terminal"
  | "ssh"
  | "database"
  | "docker";

export type ComposerContextOption = {
  kind: ComposerContextItem["kind"];
  id: string;
  label: string;
  subtitle?: string;
  disabled: boolean;
};

export type ComposerContextCatalog = {
  terminal: ComposerContextOption[];
  ssh: ComposerContextOption[];
  database: ComposerContextOption[];
  docker: ComposerContextOption[];
};

/** 从当前打开会话 / 连接列表构建 Composer 上下文候选。 */
export function useComposerContextCatalog(): ComposerContextCatalog {
  const selected = useAiComposerContextStore((s) => s.items);
  const tabs = useTerminalStore((s) => s.tabs);
  const connections = useConnectionStore((s) => s.connections);

  const selectedKey = useMemo(
    () => new Set(selected.map((item) => `${item.kind}:${item.id}`)),
    [selected],
  );

  return useMemo(() => {
    const terminal: ComposerContextOption[] = tabs.map((tab) => {
      const key = `terminal:${tab.id}`;
      return {
        kind: "terminal",
        id: tab.id,
        label: tab.title,
        subtitle: tab.session.cwd || undefined,
        disabled: selectedKey.has(key),
      };
    });

    const ssh: ComposerContextOption[] = connections
      .filter((c) => c.kind === "ssh")
      .map((conn) => ({
        kind: "ssh" as const,
        id: conn.id,
        label: conn.name,
        disabled: selectedKey.has(`ssh:${conn.id}`),
      }));

    const database: ComposerContextOption[] = connections
      .filter((c) => c.kind === "database")
      .map((conn) => ({
        kind: "database" as const,
        id: conn.id,
        label: conn.name,
        disabled: selectedKey.has(`database:${conn.id}`),
      }));

    const docker: ComposerContextOption[] = connections
      .filter((c) => c.kind === "docker")
      .map((conn) => ({
        kind: "docker" as const,
        id: conn.id,
        label: conn.name,
        disabled: selectedKey.has(`docker:${conn.id}`),
      }));

    return { terminal, ssh, database, docker };
  }, [tabs, connections, selectedKey]);
}

export function filterComposerContextOptions(
  catalog: ComposerContextCatalog,
  query: string,
): ComposerContextOption[] {
  const q = query.trim().toLowerCase();
  const all = [
    ...catalog.terminal,
    ...catalog.ssh,
    ...catalog.database,
    ...catalog.docker,
  ];
  if (!q) return all;
  return all.filter(
    (item) =>
      item.label.toLowerCase().includes(q) ||
      item.subtitle?.toLowerCase().includes(q) ||
      item.kind.includes(q),
  );
}

/** 解析输入框中光标前的 @query；无则返回 null。 */
export function parseAtMention(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const before = text.slice(0, Math.max(0, caret));
  const match = before.match(/(^|[\s\n])@([^\s@]*)$/);
  if (!match) return null;
  const query = match[2] ?? "";
  const start = before.length - query.length - 1;
  return { start, query };
}

export function stripAtMention(text: string, start: number, caret: number): string {
  return `${text.slice(0, start)}${text.slice(caret)}`.replace(/  +/g, " ");
}
