import { describe, expect, it } from "vitest";
import {
  isWebsiteSslBound,
  parseCertificateExpireDate,
  websiteCertificateInfo,
  websiteSslExpireRaw,
  websiteSslId,
} from "./serverResourceLabels";

describe("websiteCertificateInfo（sslStatus / sslExpireDate）", () => {
  it("sslStatus≠success 视为未绑定，忽略站点 expireDate 与空 SSL", () => {
    const info = websiteCertificateInfo({
      type: "proxy",
      primaryDomain: "app.example.com",
      protocol: "HTTPS",
      expireDate: "0001-01-01T00:00:00Z",
      sslStatus: "",
      sslExpireDate: "2020-01-01",
      websiteSSLId: 0,
      webSiteSSL: { id: 0, expireDate: "2020-01-01" },
    });
    expect(info.hasCert).toBe(false);
    expect(info.daysLeft).toBeNull();
  });

  it("sslStatus=success 为已绑定，到期用 sslExpireDate", () => {
    const info = websiteCertificateInfo({
      type: "proxy",
      primaryDomain: "app.example.com",
      sslStatus: "success",
      sslExpireDate: "2099-06-01",
    });
    expect(info.hasCert).toBe(true);
    expect(info.expireRaw).toBe("2099-06-01");
    expect(info.daysLeft).not.toBeNull();
    expect((info.daysLeft ?? 0) > 0).toBe(true);
  });

  it("sslStatus=success 且 sslExpireDate 已过期 → 已过期", () => {
    const info = websiteCertificateInfo({
      sslStatus: "Success",
      sslExpireDate: "2020-01-01",
    });
    expect(info.hasCert).toBe(true);
    expect(info.daysLeft).not.toBeNull();
    expect((info.daysLeft ?? 0) < 0).toBe(true);
  });

  it("sslStatus=success 但无有效过期日 → 已绑定", () => {
    const info = websiteCertificateInfo({
      sslStatus: "success",
      sslExpireDate: "0001-01-01T00:00:00Z",
    });
    expect(info.hasCert).toBe(true);
    expect(info.daysLeft).toBeNull();
    expect(info.expireRaw).toBeNull();
  });

  it("不因证书库同名域名误判", () => {
    const info = websiteCertificateInfo(
      { primaryDomain: "app.example.com", sslStatus: "failed" },
      [{ id: 9, primaryDomain: "app.example.com", expireDate: "2020-01-01" }],
    );
    expect(info.hasCert).toBe(false);
  });

  it("无 sslStatus 时回退有效 SSL id（宝塔等）", () => {
    expect(
      websiteCertificateInfo({
        webSiteSSL: { id: 12, expireDate: "2099-06-01" },
      }).hasCert,
    ).toBe(true);
    expect(
      websiteCertificateInfo({
        webSiteSSL: { id: 0, expireDate: "2099-06-01" },
      }).hasCert,
    ).toBe(false);
  });
});

describe("isWebsiteSslBound / websiteSslExpireRaw", () => {
  it("success 大小写不敏感", () => {
    expect(isWebsiteSslBound({ sslStatus: "success" })).toBe(true);
    expect(isWebsiteSslBound({ sslStatus: "SUCCESS" })).toBe(true);
    expect(isWebsiteSslBound({ sslStatus: "apply" })).toBe(false);
  });

  it("优先读 sslExpireDate", () => {
    expect(
      websiteSslExpireRaw({
        sslExpireDate: "2099-01-02",
        webSiteSSL: { expireDate: "2020-01-01" },
      }),
    ).toBe("2099-01-02");
  });
});

describe("websiteSslId / parseCertificateExpireDate", () => {
  it("id<=0 视为无效", () => {
    expect(websiteSslId({ webSiteSSL: { id: 0 } })).toBeNull();
    expect(websiteSslId({ websiteSSLId: 0 })).toBeNull();
    expect(websiteSslId({ webSiteSSL: { id: 8 } })).toBe(8);
  });

  it("忽略占位到期日", () => {
    expect(parseCertificateExpireDate("0001-01-01T00:00:00Z")).toBeNull();
    expect(parseCertificateExpireDate("1970-01-01")).toBeNull();
  });
});
