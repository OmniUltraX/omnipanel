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
import { toIpcTombstones, useClientSyncTombstoneStore } from "../../modules/clientSync/tombstones";
import { teamSyncExclusionsForIpc } from "../../modules/teamSync/exclusions";
import { useWorkspaceStore } from "../../stores/workspaceStore";

export type {
  TeamSharePushResult,
  TeamShareSummary,
  TeamSyncFetchShareResult,
  TeamSyncPeekResult,
  TeamSyncPullModulesResult,
  TeamSyncPushModulesResult,
};

function collectWorkspacesJson(): string {
  const list = useWorkspaceStore.getState().workspaces;
  const payload = list.map((w) => ({
    id: w.id,
    name: w.name,
    description: w.description ?? "",
    windowForm: w.windowForm ?? null,
    updatedAt: Date.now(),
  }));
  return JSON.stringify(payload);
}

function deletedPayload() {
  const store = useClientSyncTombstoneStore.getState();
  store.pruneExpired();
  return {
    deletedConnections: toIpcTombstones(store.listByKind("connection")),
    deletedDatabases: toIpcTombstones(store.listByKind("database")),
    deletedKnowledge: toIpcTombstones(store.listByKind("knowledge")),
    deletedHttpRequests: toIpcTombstones(store.listByKind("httpRequest")),
    deletedHttpCollections: toIpcTombstones(store.listByKind("httpCollection")),
    deletedHttpEnvironments: toIpcTombstones(store.listByKind("httpEnvironment")),
    deletedWorkspaces: toIpcTombstones(store.listByKind("workspace")),
  };
}

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

export async function pushTeamModules(
  token: string,
  teamId: number,
): Promise<TeamSyncPushModulesResult> {
  return unwrapCommand(
    commands.teamSyncPushModules({
      token,
      teamId,
      workspacesJson: collectWorkspacesJson(),
      ...deletedPayload(),
      ...teamSyncExclusionsForIpc(teamId),
    }),
  );
}

export async function pullTeamModules(
  token: string,
  teamId: number,
): Promise<TeamSyncPullModulesResult> {
  return unwrapCommand(commands.teamSyncPullModules(token, teamId));
}

export async function peekTeamModules(
  token: string,
  teamId: number,
): Promise<TeamSyncPeekResult> {
  return unwrapCommand(
    commands.teamSyncPeekModules({
      token,
      teamId,
      workspacesJson: collectWorkspacesJson(),
      ...teamSyncExclusionsForIpc(teamId),
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
