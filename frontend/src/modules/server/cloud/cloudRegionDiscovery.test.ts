import { describe, expect, it } from "vitest";
import { cloudRegionLabel } from "./cloudForm";
import { fallbackCloudRegions, cloudRegionRowLabel } from "./cloudRegionDiscovery";

describe("cloud region labels", () => {
  it("优先使用接口返回的本地名称", () => {
    expect(cloudRegionLabel("cn-shanghai", "华东2（上海）")).toBe("华东2（上海）（cn-shanghai）");
  });

  it("没有本地名称时回退到内置对照表", () => {
    expect(cloudRegionLabel("cn-hangzhou")).toContain("杭州");
  });

  it("fallback 列表保留配置顺序并去掉空值", () => {
    const rows = fallbackCloudRegions([" cn-hangzhou ", "", "cn-shanghai"]);
    expect(rows.map((r) => r.regionId)).toEqual(["cn-hangzhou", "cn-shanghai"]);
    expect(cloudRegionRowLabel(rows[0]!)).toContain("cn-hangzhou");
  });
});
