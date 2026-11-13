import { fetchDeviceIdentity } from "./auth/loginApi";

let cachedDeviceName: string | null = null;
let cachedDeviceId: string | null = null;
let initPromise: Promise<void> | null = null;
const deviceNamesById = new Map<string, string>();
let identityRevision = 0;
const identityListeners = new Set<() => void>();

function bumpIdentity(): void {
  identityRevision += 1;
  for (const listener of identityListeners) listener();
}

/**
 * 预热本机设备名缓存（应用启动时调用一次）。
 * 工作区创建等同步路径通过 getCachedDeviceName 读取，用于打 `creator:` 标签。
 */
export function initDeviceNameCache(): Promise<void> {
  if (!initPromise) {
    initPromise = fetchDeviceIdentity()
      .then((identity) => {
        rememberLocalDevice(identity.deviceId, identity.deviceName);
      })
      .catch(() => {
        cachedDeviceName = null;
        cachedDeviceId = null;
        bumpIdentity();
      });
  }
  return initPromise;
}

/** 同步读取缓存的本机设备名；未就绪或读取失败时返回 null。 */
export function getCachedDeviceName(): string | null {
  return cachedDeviceName;
}

/** 同步读取缓存的本机设备 id。 */
export function getCachedDeviceId(): string | null {
  return cachedDeviceId;
}

export function rememberLocalDevice(deviceId: string, deviceName: string): void {
  const id = deviceId.trim();
  const name = deviceName.trim();
  cachedDeviceId = id || null;
  cachedDeviceName = name || null;
  if (id && name) deviceNamesById.set(id, name);
  bumpIdentity();
}

/** 记住账号下设备 id → 名称，用来把别人的资源标成创建者名字。 */
export function rememberDeviceRoster(
  devices: Array<{ deviceId?: string | null; deviceName?: string | null }>,
): void {
  let changed = false;
  for (const device of devices) {
    const id = device.deviceId?.trim() ?? "";
    const name = device.deviceName?.trim() ?? "";
    if (!id || !name) continue;
    if (deviceNamesById.get(id) === name) continue;
    deviceNamesById.set(id, name);
    changed = true;
  }
  if (changed) bumpIdentity();
}

export function deviceNameForId(deviceId: string | null | undefined): string | null {
  const id = deviceId?.trim() ?? "";
  if (!id) return null;
  return deviceNamesById.get(id) ?? null;
}

export function subscribeDeviceIdentity(listener: () => void): () => void {
  identityListeners.add(listener);
  return () => identityListeners.delete(listener);
}

export function getDeviceIdentityRevision(): number {
  return identityRevision;
}
