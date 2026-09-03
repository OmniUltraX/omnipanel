import { describe, expect, it } from "vitest";
import { getPluginManifest, manifestCloudCapabilities, resolveLegacyPluginId } from "../../lib/pluginManifests";
import { capabilityI18nKey, cloudAccountConsoleUrl, formatCloudFieldValue, maskCloudAccessKey, parseCloudDateMs, resolveCloudPluginId } from "./cloudForm";
import {
  formatMetricValue,
  isGuestOsMetric,
  metricCardSize,
  metricSeriesStats,
  nearestPlotPoint,
} from "./cloudMetricChart";
import type { CloudCapabilityDecl } from "@omnipanel/plugin-sdk";
import { cloudCapabilitiesForPlugin, isGlobalCloudCapability, shouldShowCloudRegionFilter } from "./cloudCapabilities";
import { usePluginRuntimeStore } from "../../stores/pluginRuntimeStore";
import { cloudRemoteKindAliases, rdsEngineToDbType } from "./cloudResourceLinks";
import { makeCloudTreeKey } from "./cloudWorkspaceTabs";
import { fallbackCloudRegions } from "./cloudRegionDiscovery";
import { cloudRegionLabel } from "./cloudForm";
import { filterCloudResourceRows, matchesCloudListQuery, resolveCloudQueryRegions } from "./cloudResourceApi";
import { cloudPolicyTone, cloudStatusTone } from "./cloudDetailUi";
import { paginateCloudItems } from "./cloudPaging";
import { cloudListSlotKey, cloudRegionFingerprint, isCloudInventoryFresh } from "./cloudInventory";
import { collectExpiringCloudRows, expiryTone, formatCloudExpiryDate } from "./cloudExpiry";
import {
  CLOUD_LOG_MAX_SPAN_MS,
  clampCloudLogWindow,
  cloudLogCsvRows,
  cloudLogWindow,
  collectCloudLogDbNames,
  filterCloudLogEntries,
  msToDatetimeLocal,
  sortCloudLogEntries,
} from "./cloudLogQuery";

describe("cloud capabilities contract", () => {
  it("阿里云清单声明能力且无 ecs Tab", () => {
    const manifest = getPluginManifest("omni.cloud.aliyun");
    const caps = manifestCloudCapabilities(manifest);
    expect(caps.map((c) => c.id)).toEqual([
      "compute",
      "compute.lite",
      "network.securityGroup",
      "network.eip",
      "network.loadBalancer",
      "database",
      "database.cache",
      "storage.disk",
      "objectStorage",
      "domains",
      "certs",
    ]);
    expect(caps.find((c) => c.id === "dns")).toBeUndefined();
    expect(manifest?.contributes.ui?.panelTabs ?? []).toEqual([]);
    expect(caps.find((c) => c.id === "domains")?.scope).toBe("global");
    expect(caps.find((c) => c.id === "domains")?.detailSlots).toContain("records");
    expect(caps.find((c) => c.id === "network.securityGroup")?.detailSlots).toContain("members");
    expect(caps.find((c) => c.id === "objectStorage")?.detailSlots).toContain("overview");
    expect(caps.find((c) => c.id === "certs")?.detailSlots).toContain("overview");
    expect(caps.find((c) => c.id === "compute")?.scope).toBe("region");
    expect(caps.find((c) => c.id === "compute")?.detailSlots).toContain("backups");
    expect(caps.find((c) => c.id === "compute.lite")?.detailSlots).toContain("backups");
    expect(isGlobalCloudCapability(caps.find((c) => c.id === "certs")!)).toBe(true);
  });

  it("插件未激活时能力列表为空", () => {
    const prev = usePluginRuntimeStore.getState();
    usePluginRuntimeStore.setState({ hydrated: true, items: [] });
    expect(cloudCapabilitiesForPlugin("omni.cloud.aliyun")).toEqual([]);
    usePluginRuntimeStore.setState({ hydrated: prev.hydrated, items: prev.items });
  });

  it("legacy provider 解析到插件 id", () => {
    expect(resolveLegacyPluginId("aliyun")).toBe("omni.cloud.aliyun");
    expect(resolveCloudPluginId({ provider: "aliyun" })).toBe("omni.cloud.aliyun");
    expect(resolveCloudPluginId({ pluginId: "omni.cloud.aliyun" })).toBe("omni.cloud.aliyun");
    expect(resolveLegacyPluginId("tencent")).toBe("omni.cloud.tencent");
    expect(resolveLegacyPluginId("qcloud")).toBe("omni.cloud.tencent");
    expect(resolveCloudPluginId({ provider: "tencent" })).toBe("omni.cloud.tencent");
    expect(resolveCloudPluginId({ pluginId: "omni.cloud.tencent" })).toBe("omni.cloud.tencent");
  });

  it("账户控制台只给已知厂商首页", () => {
    expect(cloudAccountConsoleUrl("omni.cloud.aliyun")).toBe("https://home.console.aliyun.com/");
    expect(cloudAccountConsoleUrl("aliyun")).toBe("https://home.console.aliyun.com/");
    expect(cloudAccountConsoleUrl("omni.cloud.tencent")).toBe("https://console.cloud.tencent.com/");
    expect(cloudAccountConsoleUrl("tencent")).toBe("https://console.cloud.tencent.com/");
    expect(cloudAccountConsoleUrl("omni.cloud.unknown")).toBeNull();
  });
});

describe("cloud remote kind aliases", () => {
  it("新旧血缘互相匹配", () => {
    expect(cloudRemoteKindAliases("compute")).toEqual(["compute", "ecs"]);
    expect(cloudRemoteKindAliases("ecs")).toEqual(["compute", "ecs"]);
    expect(cloudRemoteKindAliases("swas")).toEqual(["compute.lite", "swas"]);
    expect(cloudRemoteKindAliases("oss")).toEqual(["objectStorage", "oss"]);
    expect(cloudRemoteKindAliases("database")).toEqual(["database", "rds"]);
    expect(rdsEngineToDbType("MySQL")).toBe("mysql");
    expect(rdsEngineToDbType("PostgreSQL")).toBe("postgres");
    expect(rdsEngineToDbType("SQLServer")).toBe("sqlserver");
    expect(rdsEngineToDbType("Redis")).toBe("redis");
  });
});

describe("cloud tree keys", () => {
  it("三层 key 稳定且不含记录层", () => {
    expect(makeCloudTreeKey({ kind: "account", accountId: "a1" })).toBe("cloud:a1");
    expect(
      makeCloudTreeKey({ kind: "capability", accountId: "a1", capability: "compute" }),
    ).toBe("cloud:a1:compute");
    expect(
      makeCloudTreeKey({
        kind: "resource",
        accountId: "a1",
        capability: "compute",
        resourceId: "i-1",
      }),
    ).toBe("cloud:a1:compute:i-1");
  });

  it("capability i18n 避开 compute.lite 点路径", () => {
    expect(capabilityI18nKey("compute.lite")).toBe("cloud.capability.computeLite");
    expect(capabilityI18nKey("compute")).toBe("cloud.capability.compute");
    expect(capabilityI18nKey("network.securityGroup")).toBe("cloud.capability.networkSecurityGroup");
    expect(capabilityI18nKey("database")).toBe("cloud.capability.database");
    expect(capabilityI18nKey("database.cache")).toBe("cloud.capability.databaseCache");
    expect(capabilityI18nKey("network.eip")).toBe("cloud.capability.networkEip");
  });
});

describe("cloud region labels", () => {
  it("优先使用接口返回的本地名称", () => {
    expect(cloudRegionLabel("cn-shanghai", "华东2（上海）")).toBe("华东2（上海）（cn-shanghai）");
  });

  it("fallback 列表保留配置顺序并带 capabilities", () => {
    const rows = fallbackCloudRegions([" cn-hangzhou ", "", "cn-shanghai"]);
    expect(rows.map((r) => r.regionId)).toEqual(["cn-hangzhou", "cn-shanghai"]);
    expect(rows[0]?.capabilities).toEqual([]);
  });

  it("AccessKey 在概览中脱敏", () => {
    expect(maskCloudAccessKey("LTAI5tChp9mA13gXFnxB8HyF")).toBe("LTAI5t••••8HyF");
    expect(maskCloudAccessKey("")).toBe("—");
  });
});

describe("cloud region filter", () => {
  const rows = [
    { id: "i-hz", name: "hz", capability: "compute", regionId: "cn-hangzhou", status: "Running", fields: {} },
    { id: "i-sh", name: "sh", capability: "compute", regionId: "cn-shanghai", status: "Running", fields: {} },
    { id: "global", name: "cert", capability: "certs", regionId: "", status: "issued", fields: {} },
  ];

  it("只选杭州时树与列表一致", () => {
    expect(filterCloudResourceRows(rows, ["cn-hangzhou"], false).map((r) => r.id)).toEqual([
      "i-hz",
      "global",
    ]);
  });

  it("global 能力不过滤地域", () => {
    expect(filterCloudResourceRows(rows, ["cn-hangzhou"], true)).toEqual(rows);
  });

  it("证书能力隐藏地域条，计算能力显示", () => {
    const caps: CloudCapabilityDecl[] = [
      { id: "compute", scope: "region", columns: [], actions: [], detailSlots: ["overview"] },
      { id: "certs", scope: "global", columns: [], actions: [], detailSlots: ["overview"] },
    ];
    expect(shouldShowCloudRegionFilter(caps, "certs")).toBe(false);
    expect(shouldShowCloudRegionFilter(caps, "compute")).toBe(true);
    expect(shouldShowCloudRegionFilter(caps, null)).toBe(true);
  });

  it("全部地域打账户配置地域，避免扫完整探测列表", () => {
    expect(resolveCloudQueryRegions(["cn-shanghai"], ["cn-hangzhou", "cn-heyuan"], ["cn-hangzhou"])).toEqual([
      "cn-shanghai",
    ]);
    expect(resolveCloudQueryRegions([], ["cn-hangzhou", "cn-heyuan", "cn-wuhan"], ["cn-hangzhou"])).toEqual([
      "cn-hangzhou",
    ]);
    expect(resolveCloudQueryRegions([], ["cn-hangzhou"], [])).toEqual(["cn-hangzhou"]);
    expect(resolveCloudQueryRegions([], [], [" cn-hangzhou ", "cn-heyuan"])).toEqual([
      "cn-hangzhou",
      "cn-heyuan",
    ]);
  });
});

describe("cloud inventory cache keys", () => {
  it("地域指纹去重排序，空筛选为 *", () => {
    expect(cloudRegionFingerprint([])).toBe("*");
    expect(cloudRegionFingerprint(["cn-shanghai", "cn-hangzhou", "cn-shanghai"])).toBe(
      "cn-hangzhou,cn-shanghai",
    );
    expect(cloudListSlotKey("compute", [])).toBe("compute::*");
    expect(cloudListSlotKey("compute", ["cn-hangzhou"])).toBe("compute::cn-hangzhou");
  });

  it("15 秒内视为新鲜", () => {
    expect(isCloudInventoryFresh(Date.now() - 1_000)).toBe(true);
    expect(isCloudInventoryFresh(Date.now() - 20_000)).toBe(false);
    expect(isCloudInventoryFresh(undefined)).toBe(false);
  });
});

describe("cloud status tone", () => {
  it("把运行中 / 拒绝 / 创建中映射成色阶", () => {
    expect(cloudStatusTone("Running")).toBe("ok");
    expect(cloudStatusTone("vpc")).toBe("ok");
    expect(cloudStatusTone("Stopped")).toBe("err");
    expect(cloudStatusTone("classic")).toBe("warn");
    expect(cloudStatusTone("3")).toBe("ok");
    expect(cloudStatusTone("1")).toBe("warn");
    expect(cloudStatusTone("2")).toBe("err");
    expect(cloudStatusTone("ISSUED")).toBe("ok");
    expect(cloudStatusTone("WILLEXPIRED")).toBe("warn");
    expect(cloudPolicyTone("accept")).toBe("ok");
    expect(cloudPolicyTone("drop")).toBe("err");
  });
});

describe("cloud field display", () => {
  it("付费类型走 i18n，未知值原样返回", () => {
    const t = (key: string) => (key === "cloud.chargeType.PrePaid" ? "包年包月" : key);
    expect(formatCloudFieldValue(t, "chargeType", "PrePaid")).toBe("包年包月");
    expect(formatCloudFieldValue(t, "chargeType", "Spot")).toBe("Spot");
    expect(formatCloudFieldValue(t, "publicIp", "1.1.1.1")).toBe("1.1.1.1");
    const tStatus = (key: string) => (key === "cloud.domainStatus.3" ? "正常" : key);
    expect(formatCloudFieldValue(tStatus, "status", "3")).toBe("正常");
    expect(formatCloudFieldValue(tStatus, "status", "Running")).toBe("Running");
    const tInst = (key: string) => (key === "cloud.instanceStatus.Running" ? "运行中" : key);
    expect(formatCloudFieldValue(tInst, "status", "Running")).toBe("运行中");
    expect(formatCloudFieldValue(tInst, "status", "Stopped")).toBe("Stopped");
  });

  it("列表搜索匹配名称、ID 与 IP", () => {
    const row = {
      id: "i-abc",
      name: "web-prod",
      capability: "compute",
      regionId: "cn-heyuan",
      status: "Running",
      fields: { publicIp: "1.2.3.4", privateIp: "10.0.0.8" },
    };
    expect(matchesCloudListQuery(row, "")).toBe(true);
    expect(matchesCloudListQuery(row, "web")).toBe(true);
    expect(matchesCloudListQuery(row, "i-abc")).toBe(true);
    expect(matchesCloudListQuery(row, "1.2.3.4")).toBe(true);
    expect(matchesCloudListQuery(row, "db-only")).toBe(false);
  });

  it("客户端分页夹紧页码并切片", () => {
    const items = Array.from({ length: 45 }, (_, i) => i + 1);
    expect(paginateCloudItems(items, 1, 20).slice).toEqual(items.slice(0, 20));
    expect(paginateCloudItems(items, 3, 20)).toMatchObject({ page: 3, from: 41, to: 45, totalPages: 3 });
    expect(paginateCloudItems(items, 9, 20).page).toBe(3);
    expect(paginateCloudItems([], 1, 20)).toMatchObject({ from: 0, to: 0, totalPages: 1 });
  });

  it("汇总 30 天内到期资源并按到期日排序", () => {
    const now = Date.parse("2026-09-02T00:00:00Z");
    const items = collectExpiringCloudRows(
      {
        lists: {
          "compute::cn-hangzhou": {
            fetchedAt: 1,
            rows: [
              {
                id: "i-payg",
                name: "web",
                capability: "compute",
                regionId: "cn-hangzhou",
                fields: { expiredTime: "2026-12-01", autoReleaseTime: "2026-09-04" },
              },
              {
                id: "i-far",
                name: "far",
                capability: "compute",
                regionId: "cn-hangzhou",
                fields: { expiredTime: "2027-01-01" },
              },
            ],
          },
          "certs::*": {
            fetchedAt: 1,
            rows: [
              { id: "c-old", name: "old.com", capability: "certs", fields: { endDate: "2026-08-20" } },
              { id: "c-soon", name: "soon.com", capability: "certs", fields: { endDate: "2026-09-12" } },
            ],
          },
          "domains::*": {
            fetchedAt: 1,
            rows: [{ id: "d1", name: "later.com", capability: "domains", fields: { expirationDate: "2026-11-01" } }],
          },
        },
      },
      ["cn-hangzhou"],
      [
        { id: "compute", scope: "region" },
        { id: "certs", scope: "global" },
        { id: "domains", scope: "global" },
      ],
      now,
    );
    expect(items.map((item) => item.row.id)).toEqual(["c-old", "i-payg", "c-soon"]);
    expect(items[0]?.tone).toBe("err");
    expect(items[1]?.field).toBe("autoReleaseTime");
    expect(expiryTone(3)).toBe("warn");
    expect(expiryTone(8)).toBe("info");
    expect(formatCloudExpiryDate(Date.parse("2026-09-12T00:00:00Z"))).toBe("2026-09-12");
  });

  it("解析阿里云日期与毫秒时间戳", () => {
    expect(parseCloudDateMs("2027-01-01")).toBe(Date.parse("2027-01-01"));
    expect(parseCloudDateMs("2027-01-01 00:00:00")).toBe(Date.parse("2027-01-01T00:00:00"));
    expect(parseCloudDateMs("1798761600000")).toBe(1798761600000);
    expect(parseCloudDateMs("1798761600")).toBe(1798761600000);
    expect(parseCloudDateMs("")).toBeNull();
  });
});

describe("cloud metric charts", () => {
  it("按指标分配卡片尺寸", () => {
    expect(metricCardSize("CPUUtilization")).toBe("hero");
    expect(metricCardSize("load_1m")).toBe("wide");
    expect(metricCardSize("DiskReadIOPS")).toBe("compact");
    expect(isGuestOsMetric("memory_usedutilization")).toBe(true);
    expect(isGuestOsMetric("CPUUtilization")).toBe(false);
  });

  it("格式化带宽并定位最近数据点", () => {
    expect(formatMetricValue(132800, "bps")).toBe("132.8K");
    expect(formatMetricValue(3.2, "%")).toBe("3.2%");
    const hit = nearestPlotPoint(
      [
        { x: 10, y: 0, ts: 1, value: 1 },
        { x: 40, y: 0, ts: 2, value: 2 },
        { x: 90, y: 0, ts: 3, value: 3 },
      ],
      45,
    );
    expect(hit?.value).toBe(2);
  });

  it("汇总当前最低最高平均", () => {
    expect(metricSeriesStats([])).toBeNull();
    expect(metricSeriesStats([
      { tsMs: 1, value: 2 },
      { tsMs: 2, value: 6 },
      { tsMs: 3, value: 4 },
    ])).toEqual({ latest: 4, min: 2, max: 6, avg: 4 });
  });
});

describe("cloudLogQuery", () => {
  it("跨度超过 31 天会截断", () => {
    const now = 1_725_278_400_000;
    const win = clampCloudLogWindow(now - 40 * 24 * 3600_000, now, now);
    expect(win.endMs - win.startMs).toBe(CLOUD_LOG_MAX_SPAN_MS);
  });

  it("自定义窗口采用本地起止时间", () => {
    const now = Date.UTC(2026, 8, 2, 8, 0, 0);
    const start = msToDatetimeLocal(now - 6 * 3600_000);
    const end = msToDatetimeLocal(now);
    const win = cloudLogWindow("custom", start, end, now);
    expect(win.endMs).toBeLessThanOrEqual(now);
    expect(win.endMs - win.startMs).toBeGreaterThan(5 * 3600_000);
  });

  it("按耗时降序", () => {
    const rows = sortCloudLogEntries(
      [
        { id: "a", tsMs: 2, fields: { queryTimes: "1" } },
        { id: "b", tsMs: 1, fields: { queryTimes: "9" } },
      ],
      "duration",
      "desc",
    );
    expect(rows[0]?.id).toBe("b");
  });

  it("耗时与 SQL 同时筛选", () => {
    const rows = filterCloudLogEntries(
      [
        { id: "a", summary: "SELECT 1", fields: { queryTimes: "0.2", sql: "SELECT 1" } },
        { id: "b", summary: "UPDATE t", fields: { queryTimes: "2", sql: "UPDATE t" } },
      ],
      "1",
      "update",
    );
    expect(rows.map((row) => row.id)).toEqual(["b"]);
  });

  it("汇总子资源和日志里的库名", () => {
    expect(
      collectCloudLogDbNames(
        ["app", "app"],
        [{ fields: { db: "report" } }, { fields: { db: "app" } }],
      ),
    ).toEqual(["app", "report"]);
  });

  it("导出行带完整 SQL", () => {
    const rows = cloudLogCsvRows([
      { tsMs: 1_725_278_400_000, summary: "SELECT 1", fields: { queryTimes: "2", host: "1.1.1.1", db: "app", sql: "SELECT 1" } },
    ]);
    expect(rows[0]).toMatchObject({ duration: "2", db: "app", sql: "SELECT 1" });
    expect(String(rows[0]?.time)).toContain("2024");
  });
});
