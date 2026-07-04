import type { Connection } from "../../../ipc/bindings";
import { normalizeServerGroup } from "./panelConnection";

export interface ServerEntry {
  id: string;
  name: string;
  address: string;
  key: string;
  serviceType: "bt" | "1panel";
  createdAt: number;
}

export interface PanelConfigJson {
  address: string;
  key: string;
  serviceType: "bt" | "1panel";
  sshConnectionId?: string;
}

export type AuthType = "password" | "privateKey";

export interface SshAuthJson {
  type: AuthType;
  password?: string;
  pem?: string;
  keyPath?: string;
  passphrase?: string | null;
}

export interface SshConfigJson {
  host: string;
  port: number;
  user: string;
  auth: SshAuthJson;
  panelConnectionId?: string;
  publicIp?: string;
}

export interface UnifiedServerFormData {
  name: string;
  host: string;
  port: string;
  user: string;
  authType: AuthType;
  password: string;
  pem: string;
  keyPath: string;
  passphrase: string;
  group: string;
  panelAddress: string;
  panelKey: string;
  serviceType: "bt" | "1panel";
}

export const EMPTY_SERVER_FORM: UnifiedServerFormData = {
  name: "",
  host: "",
  port: "22",
  user: "root",
  authType: "password",
  password: "",
  pem: "",
  keyPath: "auto",
  passphrase: "",
  group: "默认",
  panelAddress: "",
  panelKey: "",
  serviceType: "bt",
};

export function parsePanelConfig(connection: Connection): PanelConfigJson {
  let cfg: PanelConfigJson = { address: "", key: "", serviceType: "bt" };
  try {
    cfg = { ...cfg, ...(JSON.parse(connection.config || "{}") as Partial<PanelConfigJson>) };
  } catch {
    // ignore
  }
  return cfg;
}

export function parseSshConfig(connection: Connection): SshConfigJson | null {
  try {
    const cfg = JSON.parse(connection.config || "{}") as Partial<SshConfigJson> & {
      auth?: SshAuthJson & { password?: SshAuthJson | string };
    };
    if (!cfg.host || !cfg.user) return null;
    let auth: SshAuthJson = cfg.auth ?? { type: "password", password: "" };
    if (auth && typeof auth.password === "object" && auth.password !== null) {
      const nested = auth.password as SshAuthJson;
      auth = {
        type: "password",
        password: nested.password ?? "",
      };
    } else if (!auth.type) {
      if (typeof auth.password === "string" && auth.password) {
        auth = { ...auth, type: "password" };
      } else if (auth.keyPath || auth.pem) {
        auth = { ...auth, type: "privateKey" };
      } else {
        auth = { ...auth, type: "password" };
      }
    }
    return {
      host: cfg.host,
      port: typeof cfg.port === "number" ? cfg.port : 22,
      user: cfg.user,
      auth,
      panelConnectionId: cfg.panelConnectionId,
      publicIp: cfg.publicIp,
    };
  } catch {
    return null;
  }
}

export function findPanelForSsh(connections: Connection[], sshId: string): Connection | undefined {
  return connections.find((c) => {
    if (c.kind !== "panel") return false;
    return parsePanelConfig(c).sshConnectionId === sshId;
  });
}

export function findSshForPanel(connections: Connection[], panelId: string): Connection | undefined {
  const panel = connections.find((c) => c.id === panelId);
  if (!panel) return undefined;
  const sshId = parsePanelConfig(panel).sshConnectionId;
  if (!sshId) return undefined;
  return connections.find((c) => c.id === sshId && c.kind === "ssh");
}

export function connectionsToForm(
  sshConnection?: Connection,
  panelConnection?: Connection,
): UnifiedServerFormData {
  const form = { ...EMPTY_SERVER_FORM };
  if (sshConnection) {
    const cfg = parseSshConfig(sshConnection);
    if (cfg) {
      form.name = sshConnection.name;
      form.group = sshConnection.group || "默认";
      form.host = cfg.host;
      form.port = String(cfg.port);
      form.user = cfg.user;
      if (cfg.auth.type === "privateKey") {
        form.authType = "privateKey";
        form.pem = cfg.auth.pem ?? "";
        form.keyPath = cfg.auth.keyPath ?? (cfg.auth.pem ? "" : "auto");
        form.passphrase = cfg.auth.passphrase ?? "";
      } else {
        form.authType = "password";
        form.password = cfg.auth.password ?? "";
      }
    }
  }
  if (panelConnection) {
    const panel = parsePanelConfig(panelConnection);
    if (!sshConnection) {
      form.name = panelConnection.name;
      form.group = panelConnection.group || "默认";
    }
    form.panelAddress = panel.address;
    form.panelKey = panel.key;
    form.serviceType = panel.serviceType;
  }
  return form;
}

export function buildSshConnection(
  form: UnifiedServerFormData,
  existingId?: string,
  panelConnectionId?: string,
  tags?: string[],
  existingConnection?: Connection,
): Connection {
  let password = form.password;
  if (
    form.authType === "password" &&
    !password.trim() &&
    existingConnection
  ) {
    const existing = parseSshConfig(existingConnection);
    if (existing?.auth.type === "password" && existing.auth.password) {
      password = existing.auth.password;
    }
  }
  const auth =
    form.authType === "password"
      ? { type: "password" as const, password }
      : {
          type: "privateKey" as const,
          ...(form.pem.trim() ? { pem: form.pem } : {}),
          keyPath: form.keyPath || "auto",
          passphrase: form.passphrase || null,
        };
  const config: SshConfigJson = {
    host: form.host.trim(),
    port: parseInt(form.port, 10) || 22,
    user: form.user.trim(),
    auth,
  };
  if (panelConnectionId) {
    config.panelConnectionId = panelConnectionId;
  }
  return {
    id: existingId || "",
    kind: "ssh",
    name: form.name.trim(),
    group: form.group.trim() || "默认",
    envTag: "unknown",
    tags: tags ?? [],
    config: JSON.stringify(config),
  };
}

export function buildPanelConnection(
  form: UnifiedServerFormData,
  group: string,
  sshConnectionId: string,
  existingId?: string,
  createdAt?: number,
): Connection {
  const config: PanelConfigJson = {
    address: form.panelAddress.trim(),
    key: form.panelKey.trim(),
    serviceType: form.serviceType,
    sshConnectionId,
  };
  const now = Date.now();
  return {
    id: existingId || "",
    kind: "panel",
    name: form.name.trim(),
    group: normalizeServerGroup(group),
    envTag: "dev",
    config: JSON.stringify(config),
    createdAt: createdAt ?? now,
    updatedAt: now,
  };
}

export function getLinkedConnectionIds(
  connections: Connection[],
  connectionId: string,
): string[] {
  const conn = connections.find((c) => c.id === connectionId);
  if (!conn) return [connectionId];

  const ids = new Set<string>([connectionId]);
  if (conn.kind === "panel") {
    const sshId = parsePanelConfig(conn).sshConnectionId;
    if (sshId) ids.add(sshId);
  } else if (conn.kind === "ssh") {
    const panel = findPanelForSsh(connections, conn.id);
    if (panel) ids.add(panel.id);
    const panelId = parseSshConfig(conn)?.panelConnectionId;
    if (panelId) ids.add(panelId);
  }
  return [...ids];
}
