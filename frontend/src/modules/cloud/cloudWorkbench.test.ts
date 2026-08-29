import { describe, expect, it } from "vitest";
import { getPluginManifest, manifestCloudCapabilities, resolveLegacyPluginId } from "../../lib/pluginManifests";
import { capabilityI18nKey, formatCloudFieldValue, maskCloudAccessKey, resolveCloudPluginId } from "./cloudForm";
import { cloudCapabilitiesForPlugin, isGlobalCloudCapability, shouldShowCloudRegionFilter } from "./cloudCapabilities";
import { usePluginRuntimeStore } from "../../stores/pluginRuntimeStore";
import { cloudRemoteKindAliases } from "./cloudResourceLinks";
import { makeCloudTreeKey } from "./cloudWorkspaceTabs";
import { fallbackCloudRegions } from "./cloudRegionDiscovery";
import { cloudRegionLabel } from "./cloudForm";
import { filterCloudResourceRows, resolveCloudQueryRegions } from "./cloudResourceApi";
import { cloudListSlotKey, cloudRegionFingerprint, isCloudInventoryFresh } from "./cloudInventory";

describe("cloud capabilities contract", () => {
  it("阿里云清单声明能力且无 ecs Tab", () => {
    const manifest = getPluginManifest("omni.cloud.aliyun");
    const caps = manifestCloudCapabilities(manifest);
    expect(caps.map((c) => c.id)).toEqual([
      "compute",
      "compute.lite",
      "objectStorage",
      "domains",
      "certs",
    ]);
    expect(caps.find((c) => c.id === "dns")).toBeUndefined();
    expect(manifest?.contributes.ui?.panelTabs ?? []).toEqual([]);
    expect(caps.find((c) => c.id === "domains")?.scope).toBe("global");
    expect(caps.find((c) => c.id === "compute")?.scope).toBe("region");
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
  });
});

describe("cloud remote kind aliases", () => {
  it("新旧血缘互相匹配", () => {
    expect(cloudRemoteKindAliases("compute")).toEqual(["compute", "ecs"]);
    expect(cloudRemoteKindAliases("ecs")).toEqual(["compute", "ecs"]);
    expect(cloudRemoteKindAliases("swas")).toEqual(["compute.lite", "swas"]);
    expect(cloudRemoteKindAliases("oss")).toEqual(["objectStorage", "oss"]);
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
    const caps = [
      { id: "compute", scope: "region" as const, columns: [], actions: [] },
      { id: "certs", scope: "global" as const, columns: [], actions: [] },
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

describe("cloud field display", () => {
  it("付费类型走 i18n，未知值原样返回", () => {
    const t = (key: string) => (key === "cloud.chargeType.PrePaid" ? "包年包月" : key);
    expect(formatCloudFieldValue(t, "chargeType", "PrePaid")).toBe("包年包月");
    expect(formatCloudFieldValue(t, "chargeType", "Spot")).toBe("Spot");
    expect(formatCloudFieldValue(t, "publicIp", "1.1.1.1")).toBe("1.1.1.1");
  });
});
