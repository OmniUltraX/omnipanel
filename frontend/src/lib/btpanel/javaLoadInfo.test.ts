import { describe, expect, it } from "vitest";
import {
  parseBtJavaProjectLoadInfo,
  parseJvmSizeArg,
} from "./javaLoadInfo";

describe("parseBtJavaProjectLoadInfo", () => {
  it("parses flat cpu/memory percent", () => {
    const info = parseBtJavaProjectLoadInfo({
      cpu: 12.5,
      memory_percent: 33.1,
      memory_used: 128 * 1024 * 1024,
    });
    expect(info.cpuPercent).toBeCloseTo(12.5);
    expect(info.memoryPercent).toBeCloseTo(33.1);
    expect(info.memoryUsedBytes).toBe(128 * 1024 * 1024);
  });

  it("aggregates pid-keyed process map", () => {
    const info = parseBtJavaProjectLoadInfo({
      "1234": { cpu_percent: 10, memory_percent: 5, memory_used: 50_000_000 },
      "1235": { cpu_percent: 5, memory_percent: 2, memory_used: 20_000_000 },
    });
    expect(info.cpuPercent).toBeCloseTo(15);
    expect(info.memoryPercent).toBeCloseTo(7);
    expect(info.memoryUsedBytes).toBe(70_000_000);
  });

  it("does not treat large memory field as percent", () => {
    const info = parseBtJavaProjectLoadInfo({
      cpu: 1,
      memory: 256_000_000,
    });
    expect(info.cpuPercent).toBeCloseTo(1);
    expect(info.memoryPercent).toBeNull();
    expect(info.memoryUsedBytes).toBe(256_000_000);
  });

  it("parses BT get_load_info envelope (cpu_percent already percent)", () => {
    const info = parseBtJavaProjectLoadInfo({
      code: 1,
      status: true,
      msg: "success",
      data: {
        "4032227": {
          cpu_percent: 0.95,
          memory_used: 2307981312,
          memory_info: { uss: 2307981312, rss: 2321444864 },
          threads: 266,
          connects: 81,
          running_time: 2078.4,
          pid: 4032227,
          status: "睡眠",
          name: "java",
          cmdline: [
            "/www/server/java/jdk-17.0.8/bin/java",
            "-jar",
            "-Xmx1024M",
            "-Xms256M",
            "/apps/teacher-chat-backend-server/yudao-server.jar",
            "--spring.profiles.active=prod",
            "--server.port=48080",
          ],
          connections: [
            { status: "LISTEN", local_port: 48080 },
          ],
        },
      },
    });
    expect(info.cpuPercent).toBeCloseTo(0.95, 2);
    // memory_used / Xmx → 进度条百分比
    expect(info.heapMaxBytes).toBe(1024 * 1024 * 1024);
    expect(info.heapMinBytes).toBe(256 * 1024 * 1024);
    // 进程 USS > Xmx 时百分比封顶 100（原生内存/元空间等）
    expect(info.memoryPercent).toBe(100);
    expect(info.memoryUsedBytes).toBe(2307981312);
    expect(info.threads).toBe(266);
    expect(info.connects).toBe(81);
    expect(info.runningTimeSec).toBeCloseTo(2078.4);
    expect(info.pid).toBe(4032227);
    expect(info.serverPort).toBe(48080);
    expect(info.springProfile).toBe("prod");
    expect(info.jarName).toBe("yudao-server.jar");
  });

  it("parses -Xmx/-Xms size tokens", () => {
    expect(parseJvmSizeArg("-Xmx1024M")).toBe(1024 * 1024 * 1024);
    expect(parseJvmSizeArg("-Xms256M")).toBe(256 * 1024 * 1024);
    expect(parseJvmSizeArg("-Xmx1g")).toBe(1024 * 1024 * 1024);
  });
});
