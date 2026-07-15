import { quickInput } from "../../lib/quickInput";
import type { ProtocolTabKey } from "../../lib/protocolLabConfig";
import { openDockTabNow } from "../../components/dock/dockPanelLifecycle";
import { useProtocolHttpLayoutStore } from "../../stores/protocolHttpLayoutStore";
import { useProtocolLabEntryStore } from "../../stores/protocolLabEntryStore";
import { useProtocolWorkspaceStore } from "../../stores/protocolWorkspaceStore";
import { showToast } from "../../stores/toastStore";

export interface CreateProtocolSessionOptions {
  protocol: ProtocolTabKey;
  name: string;
  parentFolderId: string | null;
  http: {
    createRequest: (name: string, parentFolderId: string | null) => Promise<{ id: string; name: string } | null>;
  } | null;
  t: (key: string) => string;
}

/** 创建协议会话：先打开 Dock Tab，再异步落盘/准备资源。 */
export async function createProtocolSession({
  protocol,
  name,
  parentFolderId,
  http,
  t,
}: CreateProtocolSessionOptions): Promise<void> {
  const trimmedName = name.trim();

  if (protocol === "http") {
    if (!http) return;
    const label = trimmedName || t("protocol.sidebar.defaultRequestName");
    let draftTabId = "";
    openDockTabNow({
      applyTabSync: () => {
        draftTabId = useProtocolWorkspaceStore.getState().openSessionTab({
          protocol: "http",
          label,
          resourceId: null,
        });
      },
      prepareAsync: async () => {
        const created = await http.createRequest(label, parentFolderId);
        if (!created) {
          showToast(t("protocol.http.createRequestFailed"));
          useProtocolWorkspaceStore.getState().closeTab(draftTabId);
          return;
        }
        useProtocolWorkspaceStore.getState().bindTabResource(draftTabId, created.id, created.name);
      },
    });
    return;
  }

  const entry = useProtocolLabEntryStore.getState().createEntry({
    protocol,
    name: trimmedName || t(`protocol.tabs.${protocol}`),
  });
  const layout = useProtocolHttpLayoutStore.getState();
  layout.setEntryParent(entry.id, parentFolderId);
  if (parentFolderId) {
    layout.ensureFolderExpanded(parentFolderId);
  }
  layout.reorderSibling(
    `entry:${entry.id}`,
    parentFolderId ? { kind: "folder", folderId: parentFolderId } : { kind: "root" },
  );
  openDockTabNow({
    applyTabSync: () => {
      useProtocolWorkspaceStore.getState().openSessionTab({
        protocol: entry.protocol,
        resourceId: entry.id,
        label: entry.name,
      });
    },
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
