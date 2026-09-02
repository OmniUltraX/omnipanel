/** 1Panel v1 / v2 路由差异与“接口不存在”判定。 */

export type OnePanelRouteCandidate = {
  method: string;
  path: string;
  /** 换方法时覆盖原 body（如 GET current → POST /dashboard/current）。 */
  body?: unknown;
};

function looksLikeHtml(text: string | undefined): boolean {
  if (!text) return false;
  const lower = text.trim().toLowerCase();
  return lower.startsWith("<!doctype") || lower.startsWith("<html") || lower.includes("<html");
}

/** 404 / HTML / 路由不存在：可换 API 版本或资源路径再试。 */
export function isOnePanelRouteMiss(err: unknown): boolean {
  const status = err && typeof err === "object" && "status" in err ? Number(err.status) : NaN;
  if (status === 404) return true;
  const message = err instanceof Error ? err.message : String(err ?? "");
  const body =
    err && typeof err === "object" && "body" in err && typeof (err as { body?: unknown }).body === "string"
      ? (err as { body: string }).body
      : "";
  const hay = `${message} ${body}`.toLowerCase();
  if (looksLikeHtml(message) || looksLikeHtml(body)) return true;
  if (status === 405) return true;
  return (
    hay.includes("404") ||
    hay.includes("405") ||
    hay.includes("not found") ||
    hay.includes("method not allowed") ||
    hay.includes("html 页面") ||
    hay.includes("接口不存在") ||
    hay.includes("版本不兼容") ||
    hay.includes("鉴权或入口") ||
    (hay.includes("route") && hay.includes("exist"))
  );
}

export function polishOnePanelError(err: unknown): Error {
  if (!(err instanceof Error)) {
    return new Error("1Panel 请求失败");
  }
  const body =
    err && typeof err === "object" && "body" in err && typeof (err as { body?: unknown }).body === "string"
      ? (err as { body: string }).body
      : "";
  const hay = `${err.message} ${body}`;
  if (looksLikeHtml(hay) || /404|not found/i.test(hay)) {
    err.message =
      "1Panel 鉴权或入口失败（已尝试官方 MD5 / HMAC-SHA256 / JWT 与 v1/v2）。请把安全入口写进地址，API 白名单放行本机 IP；老版本把登录密码填进密钥、用户名默认 admin。";
  }
  return err;
}

function pushCandidate(
  out: OnePanelRouteCandidate[],
  method: string,
  path: string,
  body?: unknown,
): void {
  if (
    out.some(
      (item) =>
        item.method === method &&
        item.path === path &&
        JSON.stringify(item.body) === JSON.stringify(body),
    )
  ) {
    return;
  }
  out.push(body !== undefined ? { method, path, body } : { method, path });
}

/**
 * 同一业务在 v2 / 旧 v1 上的路径（及个别 GET/POST）差异。
 * 调用方按顺序尝试，遇路由 miss 再试下一个。
 */
export function expandOnePanelRoutes(method: string, path: string): OnePanelRouteCandidate[] {
  const verb = method.trim().toUpperCase() || "GET";
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const out: OnePanelRouteCandidate[] = [{ method: verb, path: normalized }];

  if (normalized === "/toolbox/device/base") {
    pushCandidate(out, "GET", "/dashboard/base/os");
    pushCandidate(out, "GET", "/dashboard/base/all/all");
  }

  if (normalized === "/dashboard/base/os") {
    pushCandidate(out, "GET", "/dashboard/base/all/all");
  }

  const dashboardBase = /^\/dashboard\/base\/([^/]+)\/([^/]+)$/.exec(normalized);
  if (dashboardBase) {
    pushCandidate(out, "GET", "/dashboard/base/os");
  }

  const dashboardCurrent = /^\/dashboard\/current(?:\/([^/]+)\/([^/]+))?$/.exec(normalized);
  if (verb === "GET" && dashboardCurrent) {
    const io = dashboardCurrent[1] || "all";
    const net = dashboardCurrent[2] || "all";
    if (normalized !== "/dashboard/current") {
      pushCandidate(out, "GET", "/dashboard/current");
    }
    pushCandidate(out, "POST", "/dashboard/current", { ioOption: io, netOption: net });
    pushCandidate(out, "GET", `/dashboard/base/${io}/${net}`);
    pushCandidate(out, "GET", "/dashboard/base/os");
  }

  if (normalized === "/hosts/monitor/search") {
    pushCandidate(out, verb, "/monitor/search");
  }

  if (normalized === "/databases/db/search") {
    pushCandidate(out, verb, "/databases/search");
  }
  if (normalized === "/databases/db") {
    pushCandidate(out, verb, "/databases");
  }
  if (normalized === "/databases/db/del") {
    pushCandidate(out, verb, "/databases/del");
  }

  if (normalized === "/apps/sync/remote") {
    pushCandidate(out, verb, "/apps/sync");
  }

  return out;
}

/** 浏览器直连：v2→v1，必要时把安全入口放进 URL（旧 1Panel 不认 EntranceCode 头）。 */
export function expandOnePanelRequestUrls(
  baseUrl: string,
  entrance: string,
  pathWithQuery: string,
): string[] {
  const origin = baseUrl.replace(/\/+$/, "");
  const path = pathWithQuery.startsWith("/") ? pathWithQuery : `/${pathWithQuery}`;
  const prefixes = ["/api/v2", "/api/v1"];
  const urls = prefixes.map((prefix) => `${origin}${prefix}${path}`);
  const ent = entrance.trim().replace(/^\/+|\/+$/g, "");
  if (ent) {
    for (const prefix of prefixes) {
      urls.push(`${origin}/${ent}${prefix}${path}`);
    }
  }
  return urls;
}
