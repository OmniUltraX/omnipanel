import type { ImportCandidate, PluginHost } from "@omnipanel/plugin-sdk";
import { commands, type Connection } from "../ipc/bindings";
import { unwrapCommand } from "../ipc/result";
import { getHostSelection } from "./hostSelection";
import { useConnectionStore } from "../stores/connectionStore";
import { usePluginOverlayStore } from "../stores/pluginOverlayStore";
import { candidateDedupeKey } from "./importCandidates";
import { panelCandidateMatches } from "../modules/server/panel/panelPlugin";

/** 内核发现（非插件）写入时跳过插件权限闸。 */
export const KERNEL_DOCKER_PLUGIN_ID = "omni.host.docker";

function isKernelHost(pluginId: string): boolean {
  return pluginId === KERNEL_DOCKER_PLUGIN_ID || pluginId.startsWith("omni.host.");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function findExistingCandidate(
  connections: Connection[],
  candidate: ImportCandidate,
): Connection | undefined {
  const key = candidateDedupeKey(candidate);
  return connections.find((conn) => {
    try {
      const cfg = JSON.parse(conn.config || "{}") as {
        externalSource?: { pluginId?: string; accountId?: string; remoteId?: string };
        sshConnectionId?: string;
        boundSshConnectionId?: string;
        serviceType?: string;
      };
      if (cfg.externalSource?.pluginId && cfg.externalSource.remoteId) {
        return (
          candidateDedupeKey({
            pluginId: cfg.externalSource.pluginId,
            accountId: cfg.externalSource.accountId,
            remoteId: cfg.externalSource.remoteId,
            remoteKind: "",
            name: "",
          }) === key
        );
      }
      if (candidate.remoteKind === "panel" && conn.kind === "panel") {
        return panelCandidateMatches(conn, candidate);
      }
      if (candidate.remoteKind === "docker" && conn.kind === "docker") {
        return cfg.boundSshConnectionId === candidate.accountId;
      }
    } catch {
      return false;
    }
    return false;
  });
}

function withExternalSource(
  config: Record<string, unknown>,
  candidate: ImportCandidate,
): Record<string, unknown> {
  return {
    ...config,
    externalSource: {
      pluginId: candidate.pluginId,
      accountId: candidate.accountId,
      remoteId: candidate.remoteId,
      remoteKind: candidate.remoteKind,
    },
  };
}

async function saveConnection(draft: Connection): Promise<void> {
  const saved = await useConnectionStore.getState().save(draft);
  if (!saved?.id) {
    throw new Error("保存连接失败");
  }
}

async function upsertCandidateConnection(candidate: ImportCandidate): Promise<void> {
  const cfg = asRecord(candidate.config);
  const existing = findExistingCandidate(useConnectionStore.getState().connections, candidate);
  const ts = nowSec();

  if (candidate.remoteKind === "ssh") {
    await saveConnection({
      id: existing?.id ?? "",
      kind: "ssh",
      name: candidate.name,
      group: existing?.group || "Warpgate",
      envTag: existing?.envTag || "unknown",
      tags: existing?.tags ?? [],
      config: JSON.stringify(
        withExternalSource(
          {
            host: asString(cfg.host),
            port: asNumber(cfg.port, 22),
            user: asString(cfg.user, "root"),
            auth: { type: "password", password: asString(cfg.password) },
          },
          candidate,
        ),
      ),
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    });
    return;
  }

  if (candidate.remoteKind === "panel") {
    await saveConnection({
      id: existing?.id ?? "",
      kind: "panel",
      name: candidate.name,
      group: existing?.group || "默认",
      envTag: existing?.envTag || "dev",
      tags: existing?.tags ?? [],
      config: JSON.stringify(
        withExternalSource(
          {
            address: asString(cfg.address),
            key: asString(cfg.key),
            serviceType: asString(cfg.serviceType, candidate.pluginId),
            sshConnectionId: asString(cfg.sshConnectionId, candidate.accountId),
          },
          candidate,
        ),
      ),
      credentialRef: existing?.id ? `panel-key-${existing.id}` : null,
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    });
    return;
  }

  if (candidate.remoteKind === "docker") {
    const dockerCfg = asRecord(cfg.dockerConfig) ;
    await saveConnection({
      id: existing?.id || asString(cfg.id, `docker-bound-${candidate.accountId ?? candidate.remoteId}`),
      kind: "docker",
      name: candidate.name,
      group: existing?.group || "默认",
      envTag: existing?.envTag || "unknown",
      tags: existing?.tags ?? [],
      config: JSON.stringify(withExternalSource({ ...dockerCfg }, candidate)),
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    });
    return;
  }

  if (candidate.remoteKind === "mysql" || candidate.remoteKind === "postgres") {
    await unwrapCommand(
      commands.dbSaveConnection({
        id: "",
        name: candidate.name,
        db_type: candidate.remoteKind === "postgres" ? "postgresql" : "mysql",
        host: asString(cfg.host),
        port: asNumber(cfg.port, candidate.remoteKind === "postgres" ? 5432 : 3306),
        user: asString(cfg.user),
        password: asString(cfg.password),
        database: asString(cfg.database),
        ssl: false,
        status: "unknown",
        enabled: true,
      }),
    );
    return;
  }

  throw new Error(`不支持导入类型: ${candidate.remoteKind}`);
}

export async function requirePluginPermission(
  pluginId: string,
  permission: string,
): Promise<void> {
  if (isKernelHost(pluginId)) return;
  await unwrapCommand(commands.pluginRequirePermission(pluginId, permission));
}

export function createPluginHost(pluginId: string): PluginHost {
  return {
    selection: {
      get: getHostSelection,
    },
    connections: {
      upsert: async (candidate: ImportCandidate) => {
        await requirePluginPermission(pluginId, "connections:write");
        if (candidate.pluginId !== pluginId && !isKernelHost(pluginId)) {
          throw new Error("候选 pluginId 与当前 Host 不一致");
        }
        await upsertCandidateConnection(candidate);
      },
    },
    invoke: async (method, args) =>
      unwrapCommand(commands.pluginInvoke(pluginId, method, (args ?? null) as never)),
    ui: {
      overlay: {
        show: ({ id, title, body }) =>
          usePluginOverlayStore.getState().show({ id, pluginId, title, body }),
        hide: (id) => usePluginOverlayStore.getState().hide(id),
      },
    },
  };
}
