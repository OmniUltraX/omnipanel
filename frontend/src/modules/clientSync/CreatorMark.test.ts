import { beforeEach, describe, expect, it } from "vitest";
import { rememberDeviceRoster, rememberLocalDevice } from "../../lib/deviceIdentity";
import { detailCreatorName, resolveCreatorLabel } from "./CreatorMark";

describe("创建者跟创建设备走", () => {
  beforeEach(() => {
    rememberLocalDevice("device-mz", "MZ");
    rememberDeviceRoster([
      { deviceId: "device-mz", deviceName: "MZ" },
      { deviceId: "device-home", deviceName: "MACT-HOME" },
    ]);
  });

  it("本机创建的连接，详情显示本机名字，不显示标签里的旧名字", () => {
    const tags = ["sys/creator/MACT-HOME", "sys/os/Ubuntu 24.04.4 LTS"];
    expect(detailCreatorName(tags, "device-mz")).toBe("MZ");
    expect(resolveCreatorLabel(tags, "device-mz")).toBeNull();
  });

  it("别人创建的连接，用设备号对应的名字，不用过期标签", () => {
    expect(detailCreatorName(["sys/creator/MZ"], "device-home")).toBe("MACT-HOME");
    expect(resolveCreatorLabel(["creator:MZ"], "device-home")).toBe("MACT-HOME");
  });
});
