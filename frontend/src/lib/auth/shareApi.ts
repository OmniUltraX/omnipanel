import type { CustomPanelShareSnapshot } from "../../modules/workspace/smallComponents/customPanelShare";
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
  snapshot: CustomPanelShareSnapshot;
};

/** 将自定义面板快照写入各目标团队的 OSS，并通知成员。 */
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
