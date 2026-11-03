import {
  commands,
  type TeamSharePushRequest,
  type TeamSharePushResult,
  type TeamShareSummary,
  type TeamSyncFetchShareResult,
  type TeamSyncPullModulesResult,
  type TeamSyncPushModulesResult,
} from "../../ipc/bindings";
import { formatIpcError, unwrapCommand } from "../../ipc/result";
import { CLOUD_PULL_DISABLED } from "../../modules/clientSync/syncFlags";
import { collectModulesSyncPayload } from "../../modules/clientSync/prepareModulesSyncPayload";
import { applySpaceSyncReport } from "../../modules/clientSync/pullCloudSnapshot";
import { noteSpaceSyncFinished } from "../../modules/clientSync/spaceSyncPrefs";

export type {
  TeamSharePushResult,
  TeamShareSummary,
  TeamSyncFetchShareResult,
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

/** 把本机检出和团队仓库按路径合并后上传。 */
export async function pushTeamModules(
  token: string,
  teamId: number,
): Promise<TeamSyncPushModulesResult> {
  const payload = await collectModulesSyncPayload();
  const report = await unwrapCommand(
    commands.localSpaceSync({
      token,
      teamId,
      sshSidebarTreeJson: payload.sshSidebarTreeJson,
      folderTreesJson: payload.folderTreesJson,
      customPanelsJson: payload.customPanelsJson,
      workspacesJson: payload.workspacesJson,
      conversationsJson: payload.conversationsJson,
    }),
  );
  await applySpaceSyncReport(report);
  noteSpaceSyncFinished();
  return {
    objectKey: "repo/refs/latest",
    etag: null,
    bytes: report.uploadedChunks,
  };
}

export async function pullTeamModules(
  token: string,
  teamId: number,
): Promise<TeamSyncPullModulesResult> {
  if (CLOUD_PULL_DISABLED) {
    console.warn("[team-sync] pullTeamModules skipped (CLOUD_PULL_DISABLED)");
    throw new Error("云端拉取已临时关闭，请稍后再试");
  }
  const payload = await collectModulesSyncPayload();
  const report = await unwrapCommand(
    commands.localSpaceSync({
      token,
      teamId,
      sshSidebarTreeJson: payload.sshSidebarTreeJson,
      folderTreesJson: payload.folderTreesJson,
      customPanelsJson: payload.customPanelsJson,
      workspacesJson: payload.workspacesJson,
      conversationsJson: payload.conversationsJson,
    }),
  );
  await applySpaceSyncReport(report);
  noteSpaceSyncFinished();
  return {
    objectKey: "repo/refs/latest",
    bytes: report.uploadedChunks,
    bodyJson: JSON.stringify({
      connections: Array.from({ length: report.appliedConnections }),
      databaseConnections: [],
    }),
  };
}

export async function pushTeamShare(
  request: TeamSharePushRequest,
): Promise<TeamSharePushResult> {
  return unwrapCommand(commands.teamSharePush(request));
}

export function formatTeamSyncError(error: unknown): string {
  return error instanceof Error ? error.message : formatIpcError(error as never);
}
