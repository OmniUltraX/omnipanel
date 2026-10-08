import { commands, type MeshStatus } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { getCurrentSyncTeamId } from "../../stores/currentSyncTeamStore";
import { useAuthStore } from "../../stores/authStore";
import { useUserProfileStore } from "../../stores/userProfileStore";

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

const inFlight = new Map<number, Promise<boolean>>();
let epoch = 0;

/** 加入指定团队的 mesh，不影响其他已在线的团队。 */
export async function startTeamMeshFor(teamId: number): Promise<boolean> {
  if (!Number.isFinite(teamId) || teamId <= 0) return false;
  const existing = inFlight.get(teamId);
  if (existing) return existing;
  const task = startOne(teamId).finally(() => {
    if (inFlight.get(teamId) === task) inFlight.delete(teamId);
  });
  inFlight.set(teamId, task);
  return task;
}

async function startOne(teamId: number): Promise<boolean> {
  const ticket = epoch;
  const token = useAuthStore.getState().token?.trim();
  if (!token) return false;
  try {
    const status = await unwrapCommand(commands.meshStatus(teamId), { quiet: true });
    if (status.online && status.teamId === teamId && status.ipv4.trim()) {
      return true;
    }
    const creds = await unwrapCommand(commands.teamMeshAuthKey(token, teamId), {
      quiet: true,
    });
    if (ticket !== epoch) return false;
    await unwrapCommand(
      commands.meshStart(teamId, creds.authKey, creds.controlServerUrl, creds.hostname),
      { quiet: true },
    );
    if (ticket !== epoch) {
      await unwrapCommand(commands.meshStopTeam(teamId), { quiet: true }).catch(() => undefined);
      return false;
    }
    return true;
  } catch (e) {
    console.warn("[mesh] start skipped", teamId, e);
    return false;
  }
}

/**
 * 登录或资料刷新后，把账号所属的每支团队都加入 mesh。
 * 已不在成员列表里的网会拆掉。
 */
export async function startAllTeamMeshes(): Promise<void> {
  const token = useAuthStore.getState().token?.trim();
  if (!token) {
    await stopTeamMesh();
    return;
  }
  const ids = new Set(
    useUserProfileStore
      .getState()
      .teams.map((team) => team.id)
      .filter((id) => Number.isFinite(id) && id > 0),
  );
  const ticket = epoch;
  await Promise.all([...ids].map((id) => startTeamMeshFor(id)));
  if (ticket !== epoch) return;
  try {
    const online = await unwrapCommand(commands.meshList(), { quiet: true });
    await Promise.all(
      online
        .filter((item): item is MeshStatus & { teamId: number } => {
          const teamId = item.teamId;
          return teamId != null && teamId > 0 && !ids.has(teamId);
        })
        .map((item) =>
          unwrapCommand(commands.meshStopTeam(item.teamId), { quiet: true }).catch(
            () => undefined,
          ),
        ),
    );
  } catch {
    /* 列表失败时保留已入网的团队 */
  }
}

/** 兼容旧调用：加入当前账号的全部团队 mesh，并报告当前团队是否在线。 */
export async function startTeamMesh(): Promise<boolean> {
  await startAllTeamMeshes();
  const teamId = getCurrentSyncTeamId();
  if (!teamId || teamId <= 0) return false;
  try {
    const status = await unwrapCommand(commands.meshStatus(teamId), { quiet: true });
    return Boolean(status.online && status.teamId === teamId);
  } catch {
    return false;
  }
}

export async function stopTeamMesh(): Promise<void> {
  epoch += 1;
  try {
    await unwrapCommand(commands.meshStop(), { quiet: true });
  } catch {
    /* 未入网时停止可忽略 */
  }
}

/** 等待指定团队的 tailnet IPv4 就绪；mesh 不可用或超时返回 false，不抛错。 */
export async function waitForMeshReady(
  timeoutMs = 20_000,
  teamId?: number | null,
): Promise<boolean> {
  const id = teamId && teamId > 0 ? teamId : getCurrentSyncTeamId();
  if (!id || id <= 0) return false;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    try {
      const status: MeshStatus = await unwrapCommand(commands.meshStatus(id), {
        quiet: true,
      });
      if (status.online && status.teamId === id && status.ipv4.trim()) {
        return true;
      }
    } catch {
      /* 继续轮询 */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}
