import type { Connection } from "../../../ipc/bindings";
import { normalizeServerGroup } from "./panelConnection";
import { parsePanelConfig, type PanelConfigJson } from "./serverConnection";

export interface PanelFormData {
  name: string;
  panelAddress: string;
  panelKey: string;
  serviceType: "bt" | "1panel";
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
    panelKey: panel.key,
    serviceType: panel.serviceType,
    remark,
  };
}

export function buildPanelOnlyConnection(
  form: PanelFormData,
  existing?: Connection,
): Connection {
  const config: PanelConfigJson & { remark?: string } = {
    address: form.panelAddress.trim(),
    key: form.panelKey.trim(),
    serviceType: form.serviceType,
    remark: form.remark.trim() || undefined,
  };
  // 表单不再管理 SSH 关联，编辑时保留已有绑定
  if (existing) {
    const prev = parsePanelConfig(existing);
    if (prev.sshConnectionId) {
      config.sshConnectionId = prev.sshConnectionId;
    }
  }
  const now = Date.now();
  return {
    id: existing?.id ?? "",
    kind: "panel",
    name: form.name.trim(),
    group: normalizeServerGroup(existing?.group),
    envTag: existing?.envTag?.trim() || DEFAULT_ENV_TAG,
    config: JSON.stringify(config),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}
