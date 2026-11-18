import { describe, expect, it } from "vitest";
import { collapseDevices, type AuthDevice } from "./loginApi";

function device(patch: Partial<AuthDevice> & Pick<AuthDevice, "id" | "deviceId" | "appId">): AuthDevice {
  return {
    deviceName: patch.deviceId,
    osType: "windows",
    ip: "",
    lastLoginAt: "",
    lastLogoutAt: "",
    userAgent: "",
    createdAt: "",
    updatedAt: "",
    role: "client",
    platform: "windows",
    loginStatus: "logged_out",
    online: false,
    syncTrusted: false,
    ...patch,
  };
}

describe("collapseDevices", () => {
  it("同一设备号只保留仍在使用的应用记录", () => {
    const legacy = device({
      id: 5,
      deviceId: "dddbbfc4c26326f056761e30a62147d8",
      deviceName: "MACT-OFFICE",
      appId: "default",
      updatedAt: "2026-07-30T16:42:26.994+08:00",
    });
    const current = device({
      id: 35,
      deviceId: "dddbbfc4c26326f056761e30a62147d8",
      deviceName: "MACT-OFFICE",
      appId: "omni-client",
      online: false,
      syncTrusted: true,
      loginStatus: "logged_in",
      updatedAt: "2026-11-18T10:36:02.282+08:00",
    });
    const other = device({
      id: 12,
      deviceId: "9e090b22328a",
      deviceName: "Win32",
      appId: "omni-client",
      updatedAt: "2026-11-01T00:00:00.000+08:00",
    });

    const collapsed = collapseDevices([legacy, other, current]);

    expect(collapsed.map((item) => item.id)).toEqual([35, 12]);
  });

  it("客户端和助手端即使设备号相同也各自保留", () => {
    const client = device({ id: 1, deviceId: "same", appId: "omni-client", role: "client" });
    const assistant = device({
      id: 2,
      deviceId: "same",
      appId: "omni-assistant",
      role: "assistant",
    });

    expect(collapseDevices([client, assistant]).map((item) => item.role).sort()).toEqual([
      "assistant",
      "client",
    ]);
  });
});
