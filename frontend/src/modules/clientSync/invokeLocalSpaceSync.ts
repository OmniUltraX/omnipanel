import { commands, type SpaceSyncReport, type SpaceSyncRequest } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { ensureTeamSyncKeyForTeam } from "../../lib/auth/ensureTeamSyncKey";
import { clearSyncTeamKey } from "../../lib/auth/syncTeamKeyApi";
import { getCurrentSyncTeamId } from "../../stores/currentSyncTeamStore";

let recoveryUntil = 0;
let recoveryInFlight: Promise<boolean> | null = null;

function errorText(err: unknown): { code: string; message: string } {
  if (!err || typeof err !== "object") {
    return { code: "", message: err instanceof Error ? err.message : "" };
  }
  const record = err as { code?: unknown; message?: unknown };
  return {
    code: typeof record.code === "string" ? record.code : "",
    message: typeof record.message === "string" ? record.message : "",
  };
}

/** 密钥解不开或本机还没有钥匙时，清掉错钥匙并向在线电脑要一次，再同步。 */
async function recoverSpaceKey(err: unknown): Promise<boolean> {
  if (Date.now() < recoveryUntil) return false;
  if (recoveryInFlight) return recoveryInFlight;
  const { code, message } = errorText(err);
  const decryptFailed = message.includes("解开空间");
  const missingKey = message.includes("还没有这台空间的同步密钥");
  if (code !== "auth" || (!decryptFailed && !missingKey)) return false;
  const teamId = getCurrentSyncTeamId();
  if (!teamId || teamId <= 0) return false;
  recoveryInFlight = (async () => {
    try {
      if (decryptFailed) await clearSyncTeamKey(teamId);
      const ready = await ensureTeamSyncKeyForTeam(teamId, { relayTimeoutMs: 25_000 });
      if (!ready) recoveryUntil = Date.now() + 60_000;
      return ready;
    } catch {
      recoveryUntil = Date.now() + 60_000;
      return false;
    } finally {
      recoveryInFlight = null;
    }
  })();
  return recoveryInFlight;
}

export async function invokeLocalSpaceSync(
  request: SpaceSyncRequest,
  options?: { quiet?: boolean },
): Promise<SpaceSyncReport> {
  try {
    return await unwrapCommand(commands.localSpaceSync(request), { quiet: options?.quiet });
  } catch (err) {
    if (!(await recoverSpaceKey(err))) throw err;
    return unwrapCommand(commands.localSpaceSync(request), { quiet: options?.quiet });
  }
}
