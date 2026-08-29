import { commands } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { getCurrentSyncTeamId } from "../../stores/currentSyncTeamStore";
import { useAuthStore } from "../../stores/authStore";

/** 与 omniserver `headscale.Hostname` / 桌面 Rust `mesh_hostname` 一致。 */
export function meshHostname(deviceId: string): string {
  let body = "";
  for (const ch of (deviceId ?? "").trim().toLowerCase()) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
      body += ch;
      if (body.length >= 48) break;
    }
  }
  return `op-${body || "unknown"}`;
}

let inFlight: Promise<boolean> | null = null;
let generation = 0;

/** 登录或切团队后加入当前团队 mesh；失败不阻断主流程。 */
export async function startTeamMesh(): Promise<boolean> {
  const gen = ++generation;
  if (inFlight) {
    try {
      await inFlight;
    } catch {
      /* 上一轮入网失败不阻断本轮 */
    }
  }
  if (gen !== generation) return false;
  inFlight = (async () => {
    try {
      const token = useAuthStore.getState().token?.trim();
      const teamId = getCurrentSyncTeamId();
      if (!token || !teamId || teamId <= 0) {
        await unwrapCommand(commands.meshStop(), { quiet: true }).catch(() => undefined);
        return false;
      }
      try {
        const status = await unwrapCommand(commands.meshStatus(), { quiet: true });
        if (status.online && status.teamId === teamId) {
          return true;
        }
      } catch {
        /* 状态读取失败则尝试重新入网 */
      }
      if (gen !== generation) return false;
      const creds = await unwrapCommand(commands.teamMeshAuthKey(token, teamId), {
        quiet: true,
      });
      if (gen !== generation) return false;
      await unwrapCommand(
        commands.meshStart(teamId, creds.authKey, creds.controlServerUrl, creds.hostname),
        { quiet: true },
      );
      return gen === generation;
    } catch (e) {
      console.warn("[mesh] start skipped", e);
      return false;
    }
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

export async function stopTeamMesh(): Promise<void> {
  generation += 1;
  try {
    await unwrapCommand(commands.meshStop(), { quiet: true });
  } catch {
    /* 未入网时停止可忽略 */
  }
}

/** 等待 tailnet IPv4 就绪；mesh 不可用或超时返回 false，不抛错。 */
export async function waitForMeshReady(timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    try {
      const status = await unwrapCommand(commands.meshStatus(), { quiet: true });
      if (
        status.online &&
        status.teamId != null &&
        status.teamId > 0 &&
        status.ipv4.trim()
      ) {
        return true;
      }
    } catch {
      /* 继续轮询 */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}
