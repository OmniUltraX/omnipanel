import { create } from "zustand";
import { persist } from "zustand/middleware";

export const DEVICE_CODE_LEN = 6;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

function randomDeviceCode(): string {
  const bytes = new Uint8Array(DEVICE_CODE_LEN);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < DEVICE_CODE_LEN; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

/** 规范化用户输入的设备识别码：仅保留字母数字，截断/不足则无效。 */
export function normalizeDeviceCode(raw: string): string {
  return raw.replace(/[^A-Za-z0-9]/g, "").slice(0, DEVICE_CODE_LEN);
}

export function isValidDeviceCode(code: string): boolean {
  return /^[A-Za-z0-9]{6}$/.test(code);
}

interface DeviceSyncCodeState {
  /** 6 位设备识别码（即主密码）；多机一致则可互通。不写入 OSS 路径。 */
  deviceCode: string;
  setDeviceCode: (code: string) => void;
}

export const useDeviceSyncCodeStore = create<DeviceSyncCodeState>()(
  persist(
    (set) => ({
      // 首次安装（无本地持久化）时随机生成；之后仅允许用户手改，不提供「随机生成」入口。
      deviceCode: randomDeviceCode(),
      setDeviceCode: (code) => {
        const next = normalizeDeviceCode(code);
        if (!isValidDeviceCode(next)) return;
        set({ deviceCode: next });
      },
    }),
    {
      name: "omnipanel-device-sync-code.v1",
      version: 1,
      partialize: (state) => ({ deviceCode: state.deviceCode }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        if (!isValidDeviceCode(state.deviceCode)) {
          state.deviceCode = randomDeviceCode();
        }
      },
    },
  ),
);

export function getDeviceSyncCode(): string {
  const code = useDeviceSyncCodeStore.getState().deviceCode;
  if (isValidDeviceCode(code)) return code;
  const next = randomDeviceCode();
  useDeviceSyncCodeStore.setState({ deviceCode: next });
  return next;
}
