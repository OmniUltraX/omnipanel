import type { CustomPanelShareSnapshot } from "../../modules/workspace/smallComponents/customPanelShare";

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

/** 分享接口占位：待服务端 API 就绪后实现。 */
export async function shareToTeamMembers(_request: ShareToMembersRequest): Promise<void> {
  throw new Error("SHARE_API_NOT_READY");
}
