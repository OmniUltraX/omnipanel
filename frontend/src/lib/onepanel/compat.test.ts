import { describe, expect, it } from "vitest";
import { OnePanelApiError } from "./types";
import {
  expandOnePanelRequestUrls,
  expandOnePanelRoutes,
  isOnePanelRouteMiss,
  polishOnePanelError,
} from "./compat";

describe("onepanel compat", () => {
  it("expandOnePanelRoutes 覆盖设备 / 库 / 应用同步别名", () => {
    expect(expandOnePanelRoutes("POST", "/toolbox/device/base")).toEqual([
      { method: "POST", path: "/toolbox/device/base" },
      { method: "GET", path: "/dashboard/base/os" },
      { method: "GET", path: "/dashboard/base/all/all" },
    ]);
    expect(expandOnePanelRoutes("POST", "databases/db/search").map((item) => item.path)).toEqual([
      "/databases/db/search",
      "/databases/search",
    ]);
    expect(expandOnePanelRoutes("POST", "/databases/db/del").map((item) => item.path)).toEqual([
      "/databases/db/del",
      "/databases/del",
    ]);
    expect(expandOnePanelRoutes("POST", "/apps/sync/remote").map((item) => item.path)).toEqual([
      "/apps/sync/remote",
      "/apps/sync",
    ]);
  });

  it("expandOnePanelRoutes 监控 current 覆盖 v1.9 GET / v1.10 POST", () => {
    expect(expandOnePanelRoutes("GET", "/dashboard/current/all/all")).toEqual([
      { method: "GET", path: "/dashboard/current/all/all" },
      { method: "GET", path: "/dashboard/current" },
      { method: "POST", path: "/dashboard/current", body: { ioOption: "all", netOption: "all" } },
      { method: "GET", path: "/dashboard/base/all/all" },
      { method: "GET", path: "/dashboard/base/os" },
    ]);
    expect(expandOnePanelRoutes("GET", "/dashboard/base/os").map((item) => item.path)).toEqual([
      "/dashboard/base/os",
      "/dashboard/base/all/all",
    ]);
  });

  it("isOnePanelRouteMiss 识别 404 与 HTML", () => {
    expect(isOnePanelRouteMiss(new OnePanelApiError("1Panel API 错误 (404 Not Found)", 404, "<html>"))).toBe(
      true,
    );
    expect(isOnePanelRouteMiss(new OnePanelApiError("1Panel 返回了 HTML 页面而非 JSON", 200, "<!DOCTYPE"))).toBe(
      true,
    );
    expect(isOnePanelRouteMiss(new OnePanelApiError("API 接口密钥错误", 401))).toBe(false);
  });

  it("polishOnePanelError 去掉 nginx HTML 堆栈", () => {
    const err = new OnePanelApiError("1Panel API 错误 (404 Not Found)", 404, "<html>404</html>");
    expect(polishOnePanelError(err).message).toContain("鉴权或入口失败");
    expect(polishOnePanelError(err).message).not.toContain("<html>");
  });

  it("expandOnePanelRequestUrls 含安全入口路径", () => {
    expect(expandOnePanelRequestUrls("http://a:7777", "ent", "/apps/search")).toEqual([
      "http://a:7777/api/v2/apps/search",
      "http://a:7777/api/v1/apps/search",
      "http://a:7777/ent/api/v2/apps/search",
      "http://a:7777/ent/api/v1/apps/search",
    ]);
  });
});
