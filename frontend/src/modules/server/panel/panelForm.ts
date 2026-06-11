import type { Connection } from "../../../ipc/bindings";
import { normalizeServerGroup } from "./panelConnection";
import { parsePanelConfig, type PanelConfigJson } from "./serverConnection";

export interface PanelFormData {
  name: string;
  group: string;
  envTag: string;
  panelAddress: string;
  panelKey: string;
  serviceType: "bt" | "1panel";
  remark: string;
}

export const EMPTY_PANEL_FORM: PanelFormData = {
  name: "",
  group: "默认",
  envTag: "dev",
  panelAddress: "",
  panelKey: "",
  serviceType: "bt",
  remark: "",
};

const ENV_OPTIONS = ["local", "dev", "staging", "prod", "unknown"] as const;

export function normalizePanelEnvTag(tag: string | undefined): string {
  return ENV_OPTIONS.includes(tag as (typeof ENV_OPTIONS)[number]) ? (tag as string) : "dev";
}

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
    group: connection.group || "默认",
    envTag: normalizePanelEnvTag(connection.envTag),
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
    group: normalizeServerGroup(form.group),
    envTag: normalizePanelEnvTag(form.envTag),
    config: JSON.stringify(config),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}
