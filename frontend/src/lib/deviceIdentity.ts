import { fetchDeviceIdentity } from "./auth/loginApi";

let cachedDeviceName: string | null = null;
let initPromise: Promise<void> | null = null;

/**
 * 预热本机设备名缓存（应用启动时调用一次）。
 * 工作区创建等同步路径通过 getCachedDeviceName 读取，用于打 `creator:` 标签。
 */
export function initDeviceNameCache(): Promise<void> {
  if (!initPromise) {
    initPromise = fetchDeviceIdentity()
      .then((identity) => {
        cachedDeviceName = identity.deviceName?.trim() || null;
      })
      .catch(() => {
        cachedDeviceName = null;
      });
  }
  return initPromise;
}

/** 同步读取缓存的本机设备名；未就绪或读取失败时返回 null。 */
export function getCachedDeviceName(): string | null {
  return cachedDeviceName;
}
