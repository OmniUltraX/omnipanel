import { commands } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { getCurrentSyncTeamId } from "../../stores/currentSyncTeamStore";

/** 当前同步团队的本机密钥状态。 */
export async function getSyncTeamKeyStatus(teamId?: number | null) {
  const id = teamId ?? getCurrentSyncTeamId();
  if (!id || id <= 0) {
    throw new Error("无法解析当前同步团队");
  }
  return unwrapCommand(commands.syncTeamKeyStatus(id), { quiet: true });
}

/** 首台设备或 push 前：获取或创建团队同步密钥。 */
export async function ensureSyncTeamKey(teamId?: number | null) {
  const id = teamId ?? getCurrentSyncTeamId();
  if (!id || id <= 0) {
    throw new Error("无法解析当前同步团队");
  }
  return unwrapCommand(commands.syncTeamKeyGetOrCreate(id));
}

export async function clearSyncTeamKey(teamId?: number | null) {
  const id = teamId ?? getCurrentSyncTeamId();
  if (!id || id <= 0) {
    throw new Error("无法解析当前同步团队");
  }
  await unwrapCommand(commands.syncTeamKeyClear(id));
}

export async function exportSyncTeamKeyFile(
  path: string,
  opts?: { teamId?: number | null; passphrase?: string | null },
) {
  const id = opts?.teamId ?? getCurrentSyncTeamId();
  if (!id || id <= 0) {
    throw new Error("无法解析当前同步团队");
  }
  await unwrapCommand(
    commands.syncTeamKeyExportFile(id, path, opts?.passphrase?.trim() || null),
  );
}

export async function importSyncTeamKeyFile(
  path: string,
  opts?: { teamId?: number | null; passphrase?: string | null },
) {
  const id = opts?.teamId ?? getCurrentSyncTeamId();
  if (!id || id <= 0) {
    throw new Error("无法解析当前同步团队");
  }
  return unwrapCommand(
    commands.syncTeamKeyImportFile(id, path, opts?.passphrase?.trim() || null),
  );
}
