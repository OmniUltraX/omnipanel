import type { ImportCandidate } from "@omnipanel/plugin-sdk";

export const WARPGATE_PLUGIN_ID = "omni.importer.warpgate";

export type WarpgateTargetKind = "ssh" | "mysql" | "postgres";

/** Warpgate HTTP /targets 的精简映射。host 必须是堡垒入口，禁止内网直连 IP。 */
export type WarpgateTarget = {
  id: string;
  name: string;
  kind: WarpgateTargetKind;
  /** 堡垒入口主机（Warpgate 监听地址） */
  bastionHost: string;
  bastionPort: number;
  username?: string;
  password?: string;
  /** 仅作展示，不得写入连接 host */
  internalHost?: string;
};

export const MOCK_WARPGATE_TARGETS: WarpgateTarget[] = [
  {
    id: "tgt-ssh-web-1",
    name: "prod-web-1",
    kind: "ssh",
    bastionHost: "bastion.example.com",
    bastionPort: 2222,
    username: "root",
    internalHost: "10.0.1.12",
  },
  {
    id: "tgt-mysql-app",
    name: "app-mysql",
    kind: "mysql",
    bastionHost: "bastion.example.com",
    bastionPort: 33306,
    username: "app",
    internalHost: "10.0.2.20",
  },
];

export function protocolUser(
  loginUser: string,
  targetName: string,
  kind: WarpgateTargetKind,
): string {
  const user = loginUser.trim();
  const target = targetName.trim();
  if (user && (user.includes(":") || user.includes("#"))) return user;
  if (user && target) {
    return kind === "mysql" || kind === "postgres" ? `${user}#${target}` : `${user}:${target}`;
  }
  return user || target;
}

export function targetsToCandidates(
  accountId: string | undefined,
  targets: WarpgateTarget[],
  pluginId = WARPGATE_PLUGIN_ID,
): ImportCandidate[] {
  return targets.map((target) => {
    const config: Record<string, unknown> = {
      host: target.bastionHost,
      port: target.bastionPort,
      user: protocolUser(target.username ?? "", target.name, target.kind),
      via: "warpgate-bastion",
    };
    if (target.password) config.password = target.password;
    return {
      pluginId,
      accountId,
      remoteId: target.id,
      remoteKind: target.kind,
      name: target.name,
      config,
    };
  });
}
