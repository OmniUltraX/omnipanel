import type { Connection } from "../../../ipc/bindings";
import { normalizeServerGroup } from "./panelConnection";
import { parsePanelConfig, type PanelConfigJson } from "./serverConnection";
import { panelServiceTypeToPluginId } from "./panelPlugin";

export interface PanelFormData {
  name: string;
  panelAddress: string;
  panelKey: string;
  serviceType: string;
  remark: string;
}

export const EMPTY_PANEL_FORM: PanelFormData = {
  name: "",
  panelAddress: "",
  panelKey: "",
  serviceType: "bt",
  remark: "",
};

const DEFAULT_ENV_TAG = "dev";

export function panelConnectionToForm(connection: Connection): PanelFormData {
  const panel = parsePanelConfig(connection);
  let remark = "";
  try {
    const raw = JSON.parse(connection.config || "{}") as { remark?: string };
    remark = raw.remark ?? "";
  } catch {
    // ignore
  }
  return {
    name: connection.name,
    panelAddress: panel.address,
    // API Key 在 Vault；打开表单时由 ServerConnectionDialog 从 Vault 回显
    panelKey: "",
    serviceType: panel.serviceType,
    remark,
  };
}

export function buildPanelOnlyConnection(
  form: PanelFormData,
  existing?: Connection,
  tags: string[] = [],
  bindSshConnectionId?: string,
): Connection {
  const config: PanelConfigJson & { remark?: string } = {
    address: form.panelAddress.trim(),
    key: form.panelKey.trim(),
    serviceType: panelServiceTypeToPluginId(form.serviceType),
    remark: form.remark.trim() || undefined,
  };
  // 表单不再管理 SSH 关联，编辑时保留已有绑定
  if (existing) {
    const prev = parsePanelConfig(existing);
    if (prev.sshConnectionId) {
      config.sshConnectionId = prev.sshConnectionId;
    }
  } else if (bindSshConnectionId?.trim()) {
    // 从 SSH 概览「一键管理」打开时绑定当前主机
    config.sshConnectionId = bindSshConnectionId.trim();
  }
  const now = Date.now();
  return {
    id: existing?.id ?? "",
    kind: "panel",
    name: form.name.trim(),
    group: normalizeServerGroup(existing?.group),
    envTag: existing?.envTag?.trim() || DEFAULT_ENV_TAG,
    tags,
    // 编辑留空密钥时必须带回 credentialRef，避免后端覆盖成 null
    credentialRef: existing?.credentialRef ?? (existing?.id ? `panel-key-${existing.id}` : null),
    config: JSON.stringify(config),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}
