import {
  commands,
  type TeamSharePushRequest,
  type TeamSharePushResult,
  type TeamShareSummary,
  type TeamSyncFetchShareResult,
  type TeamSyncPeekResult,
  type TeamSyncPullModulesResult,
  type TeamSyncPushModulesResult,
} from "../../ipc/bindings";
import { formatIpcError, unwrapCommand } from "../../ipc/result";
import { CLOUD_PULL_DISABLED } from "../../modules/clientSync/syncFlags";
import { collectModulesSyncPayload } from "../../modules/clientSync/prepareModulesSyncPayload";
import { teamSyncExclusionsForIpc } from "../../modules/teamSync/exclusions";

export type {
  TeamSharePushResult,
  TeamShareSummary,
  TeamSyncFetchShareResult,
  TeamSyncPeekResult,
  TeamSyncPullModulesResult,
  TeamSyncPushModulesResult,
};

export async function listTeamShares(
  token: string,
  teamId: number,
): Promise<TeamShareSummary[]> {
  return unwrapCommand(commands.teamSyncListShares(token, teamId), {
    quiet: true,
    logLabel: "[team-sync]",
  });
}

export async function fetchTeamShare(
  token: string,
  teamId: number,
  shareId: string,
): Promise<TeamSyncFetchShareResult> {
  return unwrapCommand(commands.teamSyncFetchShare(token, teamId, shareId));
}

/** 将本机模块快照完整上传至团队 OSS（不过滤「取消同步」项）。 */
export async function pushTeamModules(
  token: string,
  teamId: number,
): Promise<TeamSyncPushModulesResult> {
  return unwrapCommand(
    commands.teamSyncPushModules({
      token,
      teamId,
      ...collectModulesSyncPayload(),
    }),
  );
}

export async function pullTeamModules(
  token: string,
  teamId: number,
): Promise<TeamSyncPullModulesResult> {
  if (CLOUD_PULL_DISABLED) {
    console.warn("[team-sync] pullTeamModules skipped (CLOUD_PULL_DISABLED)");
    throw new Error("云端拉取已临时关闭，请稍后再试");
  }
  return unwrapCommand(commands.teamSyncPullModules(token, teamId));
}

export async function peekTeamModules(
  token: string,
  teamId: number,
  options?: { afterUpload?: boolean },
): Promise<TeamSyncPeekResult> {
  return unwrapCommand(
    commands.teamSyncPeekModules({
      token,
      teamId,
      ...collectModulesSyncPayload(),
      ...teamSyncExclusionsForIpc(teamId),
      afterUpload: options?.afterUpload ?? false,
    }),
    { quiet: true, logLabel: "[team-sync:peek]" },
  );
}

export async function pushTeamShare(
  request: TeamSharePushRequest,
): Promise<TeamSharePushResult> {
  return unwrapCommand(commands.teamSharePush(request));
}

export function formatTeamSyncError(error: unknown): string {
  return error instanceof Error ? error.message : formatIpcError(error as never);
}
