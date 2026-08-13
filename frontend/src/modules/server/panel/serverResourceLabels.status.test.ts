import { describe, expect, it } from "vitest";
import {
  isWebsiteRunning,
  isWebsiteStopped,
  websiteRowStatus,
  websiteStatusBadgeClass,
} from "./serverResourceLabels";

describe("website status", () => {
  it("宝塔 0/1 与布尔值正确映射", () => {
    expect(websiteRowStatus({ status: "0" })).toBe("Stopped");
    expect(websiteRowStatus({ status: "1" })).toBe("Running");
    expect(websiteRowStatus({ status: 0 })).toBe("Stopped");
    expect(websiteRowStatus({ status: 1 })).toBe("Running");
    expect(websiteRowStatus({ status: false })).toBe("Stopped");
    expect(websiteRowStatus({ status: true })).toBe("Running");
    // 宝塔 Java：pid_info 为空=未启动
    expect(websiteRowStatus({ pid_info: { pid: 1 }, status: "0" })).toBe("Running");
    expect(websiteRowStatus({ pid_info: null, status: "1" })).toBe("Stopped");
    expect(websiteRowStatus({ pid_info: "", status: "1" })).toBe("Stopped");
    expect(websiteRowStatus({ pid_info: {}, status: "1" })).toBe("Stopped");
  });

  it("1Panel Running/Stopped/normal 正确映射", () => {
    expect(websiteRowStatus({ status: "Running" })).toBe("Running");
    expect(websiteRowStatus({ status: "Stopped" })).toBe("Stopped");
    expect(websiteRowStatus({ status: "normal" })).toBe("Running");
    expect(websiteRowStatus({ status: "stop" })).toBe("Stopped");
  });

  it("「未启动」不会被误判为运行中", () => {
    expect(isWebsiteStopped("未启动")).toBe(true);
    expect(isWebsiteRunning("未启动")).toBe(false);
    expect(websiteRowStatus({ status: "未启动" })).toBe("Stopped");
    expect(websiteStatusBadgeClass("未启动")).toContain("danger");
  });

  it("已停止优先于运行中判定", () => {
    expect(isWebsiteStopped("Stopped")).toBe(true);
    expect(isWebsiteRunning("Stopped")).toBe(false);
    expect(isWebsiteStopped("已停止")).toBe(true);
    expect(isWebsiteRunning("已停止")).toBe(false);
  });
});
