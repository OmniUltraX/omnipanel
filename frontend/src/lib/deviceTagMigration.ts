import { fetchDevices } from "./auth/loginApi";
import { initDeviceNameCache, rememberDeviceRoster } from "./deviceIdentity";
import { commands } from "../ipc/bindings";
import { unwrapCommand } from "../ipc/result";
import { useAuthStore } from "../stores/authStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { scheduleClientModuleSync } from "../modules/clientSync/moduleSync";
import { uniqueTags } from "./resourceTags";
import { creatorTagValue } from "../modules/tags/tagKinds";

let migratePromise: Promise<boolean> | null = null;

/**
 * 设备标签迁移（幂等，会话内去重）。
 *
 * 旧版同步会在上传时给所有资源补当前设备名标签；现改为资源创建时打 `creator:` 标签。
 * 这里把本机资源上的旧设备名标签收成 creator。没有创建者、也没有旧设备名时不补当前设备，
 * 避免两台电脑同时在线时互相把创建者写成自己。
 */
export function runDeviceTagMigration(): Promise<boolean> {
  if (!migratePromise) {
    const p = migrate().catch((err) => {
      console.warn("[device-tag-migration] migrate failed:", err);
      return false;
    });
    // 每次拉取后都要能再按创建设备字段改一次。上次改过也不能把这次缓存住。
    void p.then(() => {
      migratePromise = null;
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
  rememberDeviceRoster(devices);
  const deviceNames = devices
    .map((d) => d.deviceName?.trim())
    .filter((n): n is string => Boolean(n));

  const report = await unwrapCommand(
    commands.clientSyncMigrateDeviceTags({ deviceNames }),
    { quiet: true },
  );

  const workspaceChanged = migrateWorkspaceTags(deviceNames, "");

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
  const existing = original.map((tag) => creatorTagValue(tag)).find((name) => name) ?? null;
  const matchedCreator = existing
    ? null
    : (original.find((tag) => names.has(tag.trim()))?.trim() ?? null);

  const next = uniqueTags(
    original.filter((tag) => !names.has(tag.trim()) && !creatorTagValue(tag)),
  );
  const creator = (existing ?? matchedCreator ?? fallbackCreator).trim();
  if (creator) next.push(`creator:${creator}`);
  return { tags: next, changed: !tagsEqual(next, original) };
}

function tagsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((t, i) => t === b[i]);
}
