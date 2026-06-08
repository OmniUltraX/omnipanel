import { commands, type SshConfigEntry } from "../ipc/bindings";
import { OPENSSH_CONFIG_GROUP } from "./sshGroups";
import {
  type EnvironmentTag,
  type WorkspaceResource,
} from "./resourceRegistry";

export const OPENSSH_HOST_ID_PREFIX = "openssh:";

let cachedHosts: WorkspaceResource[] = [];
let cachedEntries = new Map<string, SshConfigEntry>();

export function isOpenSshHostId(id: string | undefined | null): boolean {
  return !!id && id.startsWith(OPENSSH_HOST_ID_PREFIX);
}

export function openSshHostAlias(id: string): string | null {
  return isOpenSshHostId(id) ? id.slice(OPENSSH_HOST_ID_PREFIX.length) : null;
}

function inferEnvironment(alias: string, hostName: string): EnvironmentTag {
  const text = `${alias} ${hostName}`.toLowerCase();
  if (text.includes("prod")) return "prod";
  if (text.includes("staging") || text.includes("stage")) return "staging";
  if (text.includes("dev") || text.includes("local")) return "dev";
  return "unknown";
}

function entryToSubtitle(entry: SshConfigEntry): string {
  const user = entry.user ?? "user";
  const port = entry.port ?? 22;
  return `${user}@${entry.hostName}:${port}`;
}

export function sshConfigEntryToResource(entry: SshConfigEntry): WorkspaceResource {
  return {
    id: `${OPENSSH_HOST_ID_PREFIX}${entry.alias}`,
    type: "ssh",
    name: entry.alias,
    subtitle: entryToSubtitle(entry),
    modulePath: "/server",
    environment: inferEnvironment(entry.alias, entry.hostName),
    status: "idle",
    group: OPENSSH_CONFIG_GROUP,
    tags: ["OpenSSH", "~/.ssh/config"],
  };
}

export function getOpenSshConfigEntry(id: string): SshConfigEntry | null {
  return cachedEntries.get(id) ?? null;
}

export function getOpenSshHostResource(id: string): WorkspaceResource | null {
  return cachedHosts.find((host) => host.id === id) ?? null;
}

export function getCachedOpenSshHosts(): WorkspaceResource[] {
  return cachedHosts;
}

/** 从 `~/.ssh/config` 拉取 Host 并写入内存缓存（供 `ssh_connect_config_host` 等兼容路径使用）。 */
export async function refreshSshConfigHosts(): Promise<WorkspaceResource[]> {
  try {
    const res = await commands.sshListConfigHosts();
    if (res.status !== "ok") {
      cachedHosts = [];
      cachedEntries = new Map();
      return [];
    }
    const resources = res.data.map(sshConfigEntryToResource);
    cachedHosts = resources;
    cachedEntries = new Map(
      res.data.map((entry) => [`${OPENSSH_HOST_ID_PREFIX}${entry.alias}`, entry]),
    );
    return resources;
  } catch {
    cachedHosts = [];
    cachedEntries = new Map();
    return [];
  }
}
