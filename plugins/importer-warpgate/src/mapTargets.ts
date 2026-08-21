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

export function targetsToCandidates(
  accountId: string | undefined,
  targets: WarpgateTarget[],
): ImportCandidate[] {
  return targets.map((target) => ({
    pluginId: WARPGATE_PLUGIN_ID,
    accountId,
    remoteId: target.id,
    remoteKind: target.kind,
    name: target.name,
    config: {
      host: target.bastionHost,
      port: target.bastionPort,
      user: target.username ?? "",
      // 明确不把内网 IP 当作连接入口
      via: "warpgate-bastion",
    },
  }));
}
