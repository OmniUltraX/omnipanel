import type { ResourceShareSnapshot } from "../../modules/share/resourceShare";
import type { TeamSharePushResult } from "../../ipc/bindings";
import { pushTeamShare } from "./teamSyncApi";

export type ShareTargetMember = {
  teamId: number;
  teamName: string;
  unionId: string;
  displayName: string;
};

export type ShareToMembersRequest = {
  targets: ShareTargetMember[];
  snapshot: ResourceShareSnapshot;
};

/** 将资源分享快照写入各目标团队的 OSS，并通知成员。 */
export async function shareToTeamMembers(
  token: string,
  request: ShareToMembersRequest,
): Promise<TeamSharePushResult> {
  return pushTeamShare({
    token,
    snapshotJson: JSON.stringify(request.snapshot),
    targets: request.targets.map((target) => ({
      teamId: target.teamId,
      unionId: target.unionId,
      displayName: target.displayName,
    })),
  });
}
