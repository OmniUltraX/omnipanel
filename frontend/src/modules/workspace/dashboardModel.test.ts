import { describe, expect, it } from "vitest";
import type { HostSystemStats } from "../../ipc/bindings";
import dashboardEn from "../../i18n/locales/en-US/dashboard";
import dashboardZh from "../../i18n/locales/zh-CN/dashboard";
import { buildResourceBars, resolveDashboardUnknownLabel } from "./dashboardModel";

function stats(overrides: Partial<HostSystemStats> & { memory: HostSystemStats["memory"] }): HostSystemStats {
  return {
    hostId: "gui-ssh",
    hostName: "GUI fixture SSH",
    load: "",
    cpu: { usage: 22, cores: 1, frequencyMhz: null, temperature: null, perCoreUsage: [] },
    cpuCores: 1,
    cpuUsage: 22,
    disk: { used: 0, total: 0, disks: [] },
    gpu: { devices: [] },
    network: { rxSec: null, txSec: null, interfaces: [] },
    osInfo: "",
    timestamp: 1,
    ...overrides,
  } as HostSystemStats;
}

describe("buildResourceBars", () => {
  it("shows 未知 for SSH memory when total is unknown, not a bare —", () => {
    const bars = buildResourceBars(
      [
        stats({
          memory: {
            used: 0,
            total: 0,
            available: 0,
            cached: 0,
            buffers: 0,
            swapUsed: 0,
            swapTotal: 0,
            swapAvailable: 0,
          },
        }),
      ],
      new Map([["gui-ssh", "GUI fixture SSH"]]),
      { cpu: "CPU", memory: "内存", disk: "磁盘", unknown: "未知" },
    );
    const mem = bars.find((bar) => bar.id.endsWith("-mem"));
    expect(mem?.label).toBe("GUI fixture SSH — 内存");
    expect(mem?.value).toBe("未知");
    expect(mem?.value).not.toBe("—");
  });

  it("still formats known memory as used / total", () => {
    const bars = buildResourceBars(
      [
        stats({
          memory: {
            used: 1024 * 1024 * 1024,
            total: 2 * 1024 * 1024 * 1024,
            available: 1024 * 1024 * 1024,
            cached: 0,
            buffers: 0,
            swapUsed: 0,
            swapTotal: 0,
            swapAvailable: 0,
          },
        }),
      ],
      new Map([["gui-ssh", "GUI fixture SSH"]]),
      { cpu: "CPU", memory: "内存", disk: "磁盘", unknown: "未知" },
    );
    const mem = bars.find((bar) => bar.id.endsWith("-mem"));
    expect(mem?.value).toMatch(/GB/);
    expect(mem?.value).not.toBe("未知");
  });

  it("shows 未知 when the dashboard is passed a raw i18n key", () => {
    const bars = buildResourceBars(
      [
        stats({
          memory: {
            used: 0,
            total: 0,
            available: 0,
            cached: 0,
            buffers: 0,
            swapUsed: 0,
            swapTotal: 0,
            swapAvailable: 0,
          },
        }),
      ],
      new Map([["gui-ssh", "GUI fixture SSH"]]),
      { cpu: "CPU", memory: "内存", disk: "磁盘", unknown: "ssh.status.unknown" },
    );
    const mem = bars.find((bar) => bar.id.endsWith("-mem"));
    expect(mem?.value).toBe("未知");
    expect(mem?.value).not.toBe("ssh.status.unknown");
  });
});

describe("resolveDashboardUnknownLabel", () => {
  it("uses the boot dashboard locale strings and rejects raw keys", () => {
    expect(dashboardZh.meta.unknown).toBe("未知");
    expect(dashboardEn.meta.unknown).toBe("Unknown");
    expect(resolveDashboardUnknownLabel(dashboardZh.meta.unknown)).toBe("未知");
    expect(resolveDashboardUnknownLabel(dashboardEn.meta.unknown)).toBe("Unknown");
    expect(resolveDashboardUnknownLabel("ssh.status.unknown")).toBe("未知");
    expect(resolveDashboardUnknownLabel("")).toBe("未知");
    expect(resolveDashboardUnknownLabel("—")).toBe("未知");
  });
});
