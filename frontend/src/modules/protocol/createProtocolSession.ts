import { quickInput } from "../../lib/quickInput";
import type { ProtocolTabKey } from "../../lib/protocolLabConfig";
import { useProtocolHttpLayoutStore } from "../../stores/protocolHttpLayoutStore";
import { useProtocolLabEntryStore } from "../../stores/protocolLabEntryStore";
import { useProtocolWorkspaceStore } from "../../stores/protocolWorkspaceStore";

export interface CreateProtocolSessionOptions {
  protocol: ProtocolTabKey;
  name: string;
  parentFolderId: string | null;
  http: {
    createRequest: (name: string, parentFolderId: string | null) => Promise<{ id: string; name: string } | null>;
  } | null;
  t: (key: string) => string;
}

/** 创建协议会话：HTTP 写入后端，其它协议写入本地条目 store，并打开 Dock Tab。 */
export async function createProtocolSession({
  protocol,
  name,
  parentFolderId,
  http,
  t,
}: CreateProtocolSessionOptions): Promise<void> {
  const openSessionTab = useProtocolWorkspaceStore.getState().openSessionTab;
  const layout = useProtocolHttpLayoutStore.getState();

  if (protocol === "http") {
    if (!http) return;
    const created = await http.createRequest(name.trim(), parentFolderId);
    if (!created) return;
    openSessionTab({
      protocol: "http",
      resourceId: created.id,
      label: created.name,
    });
    return;
  }

  const entry = useProtocolLabEntryStore.getState().createEntry({
    protocol,
    name: name.trim() || t(`protocol.tabs.${protocol}`),
  });
  layout.setEntryParent(entry.id, parentFolderId);
  if (parentFolderId) {
    layout.ensureFolderExpanded(parentFolderId);
  }
  layout.reorderSibling(
    `entry:${entry.id}`,
    parentFolderId ? { kind: "folder", folderId: parentFolderId } : { kind: "root" },
  );
  openSessionTab({
    protocol: entry.protocol,
    resourceId: entry.id,
    label: entry.name,
  });
}

export function defaultProtocolSessionName(
  protocol: ProtocolTabKey,
  t: (key: string, ...args: unknown[]) => string,
): string {
  return protocol === "http"
    ? t("protocol.sidebar.defaultRequestName")
    : t(`protocol.tabs.${protocol}`);
}

export async function promptProtocolSessionName(
  protocol: ProtocolTabKey,
  t: (key: string, ...args: unknown[]) => string,
): Promise<string | null> {
  return quickInput({
    title: t("protocol.sidebar.newRequestTitle"),
    placeholder: t("protocol.http.requestName"),
    defaultValue: defaultProtocolSessionName(protocol, t),
    validate: (value) => (value.trim() ? null : t("protocol.sidebar.folderNameRequired")),
  });
}
