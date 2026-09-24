import { appPrompt } from "./appPrompt";
import type { ContextMenuItem } from "../components/ui/menu";
import { contextMenuIcons } from "../components/ui/menu/contextMenuIcons";
import { useSidebarNoteStore } from "../stores/sidebarNoteStore";

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** 规范化侧栏备注键片段（稳定、大小写无关）。 */
export function normalizeSidebarNotePart(value: string): string {
  return value.trim().toLowerCase();
}

/** 拼侧栏备注键：`module:kind:…parts` */
export function sidebarNoteKey(module: string, kind: string, ...parts: string[]): string {
  return [module, kind, ...parts.map(normalizeSidebarNotePart)].join(":");
}

export const SidebarNoteKeys = {
  dockerConnection: (connectionId: string) => sidebarNoteKey("docker", "connection", connectionId),
  dockerContainer: (connectionId: string, containerId: string) =>
    sidebarNoteKey("docker", "container", connectionId, containerId),
  dockerCompose: (connectionId: string, project: string) =>
    sidebarNoteKey("docker", "compose", connectionId, project),
  sshHost: (hostId: string) => sidebarNoteKey("ssh", "host", hostId),
  databaseConnection: (connectionId: string) =>
    sidebarNoteKey("database", "connection", connectionId),
  databaseTable: (connectionId: string, dbName: string, tableName: string) =>
    sidebarNoteKey("database", "table", connectionId, dbName, tableName),
  server: (serverId: string) => sidebarNoteKey("server", "server", serverId),
  filesConnection: (connectionId: string) => sidebarNoteKey("files", "connection", connectionId),
  cloudAccount: (accountId: string) => sidebarNoteKey("cloud", "account", accountId),
  cloudInstance: (accountId: string, instanceId: string) =>
    sidebarNoteKey("cloud", "instance", accountId, instanceId),
  protocolEntry: (entryId: string) => sidebarNoteKey("protocol", "entry", entryId),
  knowledgeEntry: (entryId: string) => sidebarNoteKey("knowledge", "entry", entryId),
  terminalSession: (sessionId: string) => sidebarNoteKey("terminal", "session", sessionId),
  terminalConnection: (connectionId: string) =>
    sidebarNoteKey("terminal", "connection", connectionId),
} as const;

/** 订阅单条备注；无备注时返回 undefined（稳定，避免空串闪烁）。 */
export function useSidebarNote(noteKey: string | null | undefined): string | undefined {
  return useSidebarNoteStore((s) => {
    if (!noteKey) return undefined;
    const value = s.notes[noteKey];
    return value && value.trim() ? value : undefined;
  });
}

/** 打开 Quick Input 编辑备注；清空确认后清除。 */
export async function editSidebarNote(noteKey: string, t: Translate): Promise<void> {
  if (!noteKey.trim()) return;
  const current = useSidebarNoteStore.getState().getNote(noteKey) ?? "";
  const next = await appPrompt(t("sidebarTree.notePrompt"), current, t("sidebarTree.note"));
  if (next == null) return;
  useSidebarNoteStore.getState().setNote(noteKey, next);
}

/** 右键菜单「备注」项（自定义 ContextMenu 用）。 */
export function buildSidebarNoteMenuItem(noteKey: string, t: Translate): ContextMenuItem {
  return {
    id: "sidebar-note",
    label: t("sidebarTree.note"),
    icon: contextMenuIcons.edit,
    onClick: () => {
      void editSidebarNote(noteKey, t);
    },
  };
}
