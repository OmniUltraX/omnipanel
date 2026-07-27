import { describe, expect, it } from "vitest";
import {
  defaultS3Endpoint,
  defaultS3Region,
  inferS3ProviderFromEndpoint,
  normalizeS3Provider,
  resolveS3Provider,
} from "./s3Provider";

describe("s3Provider", () => {
  it("normalizeS3Provider 兼容缺省", () => {
    expect(normalizeS3Provider(undefined)).toBe("aws");
    expect(normalizeS3Provider("aliyun")).toBe("aliyun");
    expect(normalizeS3Provider("tencent")).toBe("tencent");
    expect(normalizeS3Provider("qiniu")).toBe("qiniu");
  });

  it("defaultS3Endpoint 按供应商拼接", () => {
    expect(defaultS3Endpoint("aliyun", "oss-cn-beijing")).toBe(
      "https://oss-cn-beijing.aliyuncs.com",
    );
    expect(defaultS3Endpoint("aliyun", "cn-hangzhou")).toBe(
      "https://oss-cn-hangzhou.aliyuncs.com",
    );
    expect(defaultS3Endpoint("tencent", "ap-beijing")).toBe(
      "https://cos.ap-beijing.myqcloud.com",
    );
    expect(defaultS3Endpoint("qiniu", "cn-north-1")).toBe(
      "https://s3.cn-north-1.qiniucs.com",
    );
    expect(defaultS3Region("aliyun")).toBe("oss-cn-beijing");
    expect(defaultS3Region("qiniu")).toBe("cn-north-1");
  });

  it("Endpoint 域名优先识别七牛", () => {
    expect(
      inferS3ProviderFromEndpoint("https://s3.cn-north-1.qiniucs.com"),
    ).toBe("qiniu");
    expect(
      resolveS3Provider({
        provider: "aliyun",
        endpoint: "https://s3.cn-north-1.qiniucs.com",
      }),
    ).toBe("qiniu");
  });
});
