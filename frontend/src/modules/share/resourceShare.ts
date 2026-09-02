import type {
  Connection,
  DbConnectionConfig,
  KnowledgeEntry,
  SavedHttpRequest,
} from "../../ipc/bindings";
import {
  buildCustomPanelShareSnapshot,
  type CustomPanelShareSnapshot,
} from "../workspace/smallComponents/customPanelShare";
import type { HomeCustomPanelId } from "../workspace/useDashboardStore";
import { useKnowledgeStore } from "../../stores/knowledgeStore";
import { useConnectionStore } from "../../stores/connectionStore";
import { commands } from "../../ipc/bindings";
import { newKnowledgeId } from "../knowledge/knowledgeTree";
import { scheduleAssistantSnapshotSync } from "../assistant";
import { scheduleClientModuleSync } from "../clientSync";

export type ShareResourceKind =
  | "custom-panel"
  | "knowledge-entry"
  | "http-request"
  | "ssh-connection"
  | "database-connection";

export type KnowledgeEntryShareSnapshot = {
  v: 1;
  kind: "knowledge-entry";
  label: string;
  entry: KnowledgeEntry;
};

export type HttpRequestShareSnapshot = {
  v: 1;
  kind: "http-request";
  label: string;
  request: SavedHttpRequest;
};

export type SshConnectionShareSnapshot = {
  v: 1;
  kind: "ssh-connection";
  label: string;
  connection: Connection;
};

export type DatabaseConnectionShareSnapshot = {
  v: 1;
  kind: "database-connection";
  label: string;
  connection: DbConnectionConfig;
};

export type ResourceShareSnapshot =
  | CustomPanelShareSnapshot
  | KnowledgeEntryShareSnapshot
  | HttpRequestShareSnapshot
  | SshConnectionShareSnapshot
  | DatabaseConnectionShareSnapshot;

/** 分享弹窗载荷：快照构建完成后打开，弹窗只负责选成员与发送。 */
export type ShareDialogPayload = {
  kind: ShareResourceKind;
  label: string;
  snapshot: ResourceShareSnapshot;
};

const SSH_CONFIG_SENSITIVE_KEYS = new Set([
  "password",
  "passphrase",
  "privateKey",
  "private_key",
  "privateKeyPath",
  "secret",
  "token",
]);

/** SSH config JSON 脱敏：删除常见凭据键，保留 host/port/user 等连接参数。 */
function sanitizeSshConfig(config: string | undefined): string | undefined {
  if (!config) return config;
  try {
    const parsed = JSON.parse(config) as Record<string, unknown>;
    for (const key of Object.keys(parsed)) {
      if (SSH_CONFIG_SENSITIVE_KEYS.has(key)) {
        delete parsed[key];
      }
    }
    return JSON.stringify(parsed);
  } catch {
    return undefined;
  }
}

function newSharedId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/** 自定义面板分享载荷；面板不存在返回 null。 */
export function buildCustomPanelSharePayload(panelId: string): ShareDialogPayload | null {
  const snapshot = buildCustomPanelShareSnapshot(panelId);
  if (!snapshot) return null;
  return { kind: "custom-panel", label: snapshot.label, snapshot };
}

/** 知识条目快照（内容即分享物，含 Markdown 正文与标签）。 */
export function buildKnowledgeEntrySharePayload(entry: KnowledgeEntry): ShareDialogPayload {
  return {
    kind: "knowledge-entry",
    label: entry.title,
    snapshot: {
      v: 1,
      kind: "knowledge-entry",
      label: entry.title,
      entry: { ...entry, tags: [...entry.tags] },
    },
  };
}

/** HTTP 请求快照（完整请求定义：URL/headers/body/auth，接收方可直接执行）。 */
export function buildHttpRequestSharePayload(request: SavedHttpRequest): ShareDialogPayload {
  return {
    kind: "http-request",
    label: request.name,
    snapshot: {
      v: 1,
      kind: "http-request",
      label: request.name,
      request: { ...request },
    },
  };
}

/** SSH 连接快照（脱敏：config 内凭据键与 credentialRef 均不外发，接收方需自行补密码）。 */
export function buildSshConnectionSharePayload(connection: Connection): ShareDialogPayload {
  return {
    kind: "ssh-connection",
    label: connection.name,
    snapshot: {
      v: 1,
      kind: "ssh-connection",
      label: connection.name,
      connection: {
        ...connection,
        credentialRef: null,
        config: sanitizeSshConfig(connection.config),
      },
    },
  };
}

/** 数据库连接快照（脱敏：password/has_password 清空，接收方需自行补密码）。 */
export function buildDatabaseConnectionSharePayload(
  connection: DbConnectionConfig,
): ShareDialogPayload {
  return {
    kind: "database-connection",
    label: connection.name,
    snapshot: {
      v: 1,
      kind: "database-connection",
      label: connection.name,
      connection: {
        ...connection,
        password: "",
        has_password: false,
      },
    },
  };
}

/** 导入结果：资源展示名；自定义面板额外带 panelId 便于接收后直接打开。 */
export type ImportedShareResource = {
  name: string;
  panelId?: HomeCustomPanelId;
};

/**
 * 将分享快照导入为本机新资源（新 id、不关联原集合/目录）。
 * 返回导入结果，失败返回 null。
 */
export async function importResourceShareSnapshot(
  snapshot: ResourceShareSnapshot,
): Promise<ImportedShareResource | null> {
  switch (snapshot.kind) {
    case "custom-panel": {
      const { importCustomPanelShareSnapshot } = await import(
        "../workspace/smallComponents/customPanelShare"
      );
      const panelId = importCustomPanelShareSnapshot(snapshot);
      return panelId ? { name: snapshot.label, panelId } : null;
    }
    case "knowledge-entry": {
      const entry = snapshot.entry;
      const imported: KnowledgeEntry = {
        ...entry,
        id: newKnowledgeId(),
        parentId: "",
        usageCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const ok = await useKnowledgeStore.getState().saveEntry(imported);
      return ok ? { name: imported.title } : null;
    }
    case "http-request": {
      const request = snapshot.request;
      const imported: SavedHttpRequest = {
        ...request,
        id: newSharedId("http"),
        collectionId: null,
        environmentId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const res = await commands.httpSaveRequest(imported);
      if (res.status !== "ok") return null;
      scheduleAssistantSnapshotSync();
      scheduleClientModuleSync();
      return { name: imported.name };
    }
    case "ssh-connection": {
      const connection = snapshot.connection;
      const saved = await useConnectionStore.getState().save({
        ...connection,
        id: newSharedId("ssh"),
        credentialRef: null,
        createdAt: null,
        updatedAt: null,
      });
      return saved ? { name: saved.name } : null;
    }
    case "database-connection": {
      const connection = snapshot.connection;
      const { saveConnection } = await import("../database/api");
      const imported = await saveConnection({
        ...connection,
        id: newSharedId("db"),
        password: "",
        has_password: false,
        status: "",
        ssl: connection.ssl ?? false,
        group: connection.group ?? "",
      });
      return imported ? { name: imported.name } : null;
    }
    default:
      return null;
  }
}

/** 资源类型 → 分享弹窗/列表展示文案 i18n key。 */
export function shareResourceKindLabelKey(kind: string): string {
  switch (kind) {
    case "knowledge-entry":
      return "share.resourceKind.knowledgeEntry";
    case "http-request":
      return "share.resourceKind.httpRequest";
    case "ssh-connection":
      return "share.resourceKind.sshConnection";
    case "database-connection":
      return "share.resourceKind.databaseConnection";
    default:
      return "share.resourceKind.customPanel";
  }
}
