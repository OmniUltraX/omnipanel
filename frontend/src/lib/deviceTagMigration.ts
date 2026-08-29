import { fetchDevices } from "./auth/loginApi";
import { getCachedDeviceName, initDeviceNameCache } from "./deviceIdentity";
import { commands } from "../ipc/bindings";
import { unwrapCommand } from "../ipc/result";
import { useAuthStore } from "../stores/authStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { scheduleClientModuleSync } from "../modules/clientSync/moduleSync";

let migratePromise: Promise<boolean> | null = null;

/**
 * 设备标签迁移（幂等，会话内去重）。
 *
 * 旧版同步会在上传时给所有资源补当前设备名标签；现改为资源创建时打 `creator:` 标签。
 * 这里把本机资源（含 localStorage 工作区）上的旧设备名标签清掉并补上 creator 标签，
 * 随后把干净的标签回推云端，其他设备拉取后不再出现设备名标签。
 */
export function runDeviceTagMigration(): Promise<boolean> {
  if (!migratePromise) {
    const p = migrate().catch((err) => {
      console.warn("[device-tag-migration] migrate failed:", err);
      return false;
    });
    // 无变化或失败时清除会话级缓存，允许后续拉取重试（迁移幂等，重复执行无副作用）
    void p.then((changed) => {
      if (!changed) migratePromise = null;
    });
    migratePromise = p;
  }
  return migratePromise;
}

async function migrate(): Promise<boolean> {
  const token = useAuthStore.getState().token;
  if (!token?.trim()) return false;

  await initDeviceNameCache();
  const devices = await fetchDevices(token, { quiet: true });
  const deviceNames = devices
    .map((d) => d.deviceName?.trim())
    .filter((n): n is string => Boolean(n));

  const report = await unwrapCommand(
    commands.clientSyncMigrateDeviceTags({ deviceNames }),
    { quiet: true },
  );

  const fallbackCreator = getCachedDeviceName() ?? "";
  const workspaceChanged = migrateWorkspaceTags(deviceNames, fallbackCreator);

  if (report.changed || workspaceChanged) {
    scheduleClientModuleSync();
    return true;
  }
  return false;
}

/** 工作区标签存于 localStorage，前端直接迁移（与后端 migrate_device_tags_to_creator 同规则）。 */
function migrateWorkspaceTags(deviceNames: string[], fallbackCreator: string): boolean {
  const { workspaces } = useWorkspaceStore.getState();
  let changed = false;
  const next = workspaces.map((w) => {
    const migrated = migrateTags(w.tags, deviceNames, fallbackCreator);
    if (!migrated.changed) return w;
    changed = true;
    return { ...w, tags: migrated.tags };
  });
  if (changed) {
    useWorkspaceStore.setState({ workspaces: next });
  }
  return changed;
}

function migrateTags(
  tags: string[] | undefined,
  deviceNames: string[],
  fallbackCreator: string,
): { tags: string[]; changed: boolean } {
  const original = tags ?? [];
  const names = new Set(deviceNames.map((n) => n.trim()).filter(Boolean));
  const hasCreator = original.some((t) => t.trim().toLowerCase().startsWith("creator:"));
  const matchedCreator = hasCreator
    ? null
    : original.find((t) => names.has(t.trim()))?.trim() ?? null;

  const next = original.filter((t) => !names.has(t.trim()));
  if (!hasCreator) {
    const creator = matchedCreator ?? fallbackCreator.trim();
    if (creator) {
      next.push(`creator:${creator}`);
    }
  }
  return { tags: next, changed: !tagsEqual(next, original) };
}

function tagsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((t, i) => t === b[i]);
}
